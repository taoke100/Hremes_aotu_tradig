/**
 * Multi-Provider AI Engine — MiniMax / DeepSeek / Qwen
 * Three-tier failover: priority 1 (primary) → priority 2 (deepseek) → priority 3 (qwen)
 */
import type { AIDecision, MarketSummary, TradeRecord } from "./types.js";

const MINIMAX_KEY = process.env.MINIMAX_API_KEY ?? "";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M2.7";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-chat";
const QWEN_KEY = process.env.QWEN_API_KEY ?? "";
const QWEN_MODEL = process.env.QWEN_MODEL ?? "qwen-plus";
const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

const TIMEOUT_MS = 15_000;
const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 5;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AIConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

interface ProviderTier {
  config: AIConfig;
  type: "minimax" | "deepseek" | "qwen";
  priority: number; // 1=primary, 2=first backup, 3=second backup
  consecutiveFailures: number;
}

// ── Prompt Builder ───────────────────────────────────────────

function buildSystemPrompt(skillContent: string): string {
  return `${skillContent}

## Output Format (MUST follow exactly)
Respond ONLY with valid JSON:
{
  "action": "HOLD" | "OPEN_LONG" | "OPEN_SHORT" | "CLOSE_LONG" | "CLOSE_SHORT",
  "instrument": "BTCUSDT",
  "confidence": 0.0-1.0,
  "reasoning": "why...",
  "size": 1-5,
  "leverage": 1-5,
  "stop_loss": 0.0,
  "take_profit": 0.0
}
confidence < 0.5 → action MUST be "HOLD".
If in a position, prefer HOLD unless strong counter-signal (confidence > 0.8).`;
}

function buildUserPrompt(
  marketData: MarketSummary,
  positions: { instId: string; posSide: string; avgPx: string; upl: string }[],
  account: { totalEq: string },
  recentTrades: TradeRecord[],
): string {
  const lines: string[] = ["## Account Status", `- Equity: ${account.totalEq} USDT`];

  if (positions.length > 0) {
    lines.push("## Open Positions");
    for (const p of positions) {
      lines.push(`- ${p.instId} ${p.posSide} | Entry: ${p.avgPx} | UPL: ${p.upl}`);
    }
  }

  lines.push("\n## Market Data (all USDT-M perpetuals)");
  for (const [sym, data] of Object.entries(marketData)) {
    const t = data.ticker;
    const r1h = data.rsi_1h;
    const rsi6 = data.rsi_6_1h;
    const r4h = data.rsi_4h;
    const fr = data.fundingRate;
    lines.push(
      `### ${sym}`,
      `  Price: ${t?.last ?? "?"} | 24h: ${t?.changePct24h ?? "?"}%`,
      `  RSI(14) 1H: ${r1h ?? "?"} | RSI(6) 1H: ${rsi6 ?? "?"} | RSI(14) 4H: ${r4h ?? "?"}`,
      `  Funding: ${fr != null ? (fr * 100).toFixed(4) + "%" : "?"}`,
    );
  }

  if (recentTrades.length > 0) {
    lines.push("\n## Recent Trades");
    for (const t of recentTrades.slice(-3)) {
      lines.push(`- ${t.time} ${t.action} ${t.symbol} ${t.direction} PnL: ${t.pnl}`);
    }
  }

  return lines.join("\n");
}

// ── Chat Completion ─────────────────────────────────────────

async function chatComplete(
  config: AIConfig,
  messages: ChatMessage[],
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI API ${res.status}: ${text}`);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };

    if (json.error?.message) {
      throw new Error(`AI error: ${json.error.message}`);
    }

    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// ── Parse AI Response ────────────────────────────────────────

function parseAIDecision(raw: string, fallbackInstrument: string): AIDecision {
  // Try JSON extraction
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as AIDecision;
      if (parsed.action && parsed.confidence !== undefined) {
        return {
          action: parsed.action,
          instrument: parsed.instrument ?? fallbackInstrument,
          confidence: Math.min(1, Math.max(0, Number(parsed.confidence))),
          reasoning: parsed.reasoning ?? "",
          size: Number(parsed.size) || 1,
          leverage: Number(parsed.leverage) || 3,
          stop_loss: Number(parsed.stop_loss) || 0,
          take_profit: Number(parsed.take_profit) || 0,
        };
      }
    } catch {
      // fall through
    }
  }

  // Fallback: HOLD on parse error
  return {
    action: "HOLD",
    instrument: fallbackInstrument,
    confidence: 0,
    reasoning: `解析失败，原文: ${raw.slice(0, 200)}`,
  };
}

// ── Engine ──────────────────────────────────────────────────

export interface AIEngineConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  type: "minimax" | "deepseek" | "qwen";
}

export class AIEngine {
  private providers: ProviderTier[] = [];
  private currentProviderIndex = 0;
  private recoveryCounter = 0;

  /**
   * @param providerConfig  Per-trader AI config from SystemConfig.ai_providers[key].
   *                         If omitted, builds from env vars (MiniMax primary, DeepSeek/Qwen fallback).
   */
  constructor(providerConfig?: AIEngineConfig) {
    // Build provider list from env vars (all three tiers)
    const envProviders: ProviderTier[] = [];

    if (MINIMAX_KEY) {
      envProviders.push({
        config: {
          apiKey: MINIMAX_KEY,
          model: MINIMAX_MODEL,
          baseUrl: MINIMAX_BASE_URL,
        },
        type: "minimax",
        priority: 1,
        consecutiveFailures: 0,
      });
    }

    if (DEEPSEEK_KEY) {
      envProviders.push({
        config: {
          apiKey: DEEPSEEK_KEY,
          model: DEEPSEEK_MODEL,
          baseUrl: DEEPSEEK_BASE_URL,
        },
        type: "deepseek",
        priority: 2,
        consecutiveFailures: 0,
      });
    }

    if (QWEN_KEY) {
      envProviders.push({
        config: {
          apiKey: QWEN_KEY,
          model: QWEN_MODEL,
          baseUrl: QWEN_BASE_URL,
        },
        type: "qwen",
        priority: 3,
        consecutiveFailures: 0,
      });
    }

    if (providerConfig) {
      // Per-trader config: use it as primary (priority 1), others from env as backup
      const primaryTier: ProviderTier = {
        config: providerConfig,
        type: providerConfig.type,
        priority: 1,
        consecutiveFailures: 0,
      };

      // Re-assign priorities: existing env providers shift to priority 2, 3
      const backupProviders = envProviders.filter((p) => p.type !== providerConfig.type);
      this.providers = [primaryTier, ...backupProviders];
    } else {
      // Env-var defaults: use env providers sorted by priority
      this.providers = envProviders.sort((a, b) => a.priority - b.priority);
    }

    // Filter out any providers with empty API keys (belt and suspenders)
    this.providers = this.providers.filter((p) => p.config.apiKey);

    if (this.providers.length === 0) {
      throw new Error("[AI Engine] No AI providers available. Set MINIMAX_API_KEY, DEEPSEEK_API_KEY, or QWEN_API_KEY.");
    }

    // Ensure currentProviderIndex is valid
    this.currentProviderIndex = 0;

    const providerList = this.providers.map((p) => `${p.type}(p${p.priority})`).join(" → ");
    console.log(`[AI Engine] Providers: ${providerList}`);
  }

  private get currentProvider(): ProviderTier {
    return this.providers[this.currentProviderIndex];
  }

  private get primaryProvider(): ProviderTier | undefined {
    return this.providers.find((p) => p.priority === 1);
  }

  private switchToNextProvider(): boolean {
    const nextIndex = this.currentProviderIndex + 1;
    if (nextIndex < this.providers.length) {
      const nextProvider = this.providers[nextIndex];
      console.log(`[AI Engine] ${this.currentProvider.type} failed 3x, switching to ${nextProvider.type}`);
      this.currentProviderIndex = nextIndex;
      return true;
    }
    return false;
  }

  private attemptRecoveryToPrimary(): boolean {
    const primary = this.primaryProvider;
    if (!primary) return false;

    const currentIdx = this.currentProviderIndex;
    const primaryIdx = this.providers.findIndex((p) => p.priority === 1);

    if (primaryIdx >= 0 && primaryIdx < currentIdx) {
      console.log(`[AI Engine] Recovery: ${this.currentProvider.type} recovered, switching back to primary`);
      this.currentProviderIndex = primaryIdx;
      return true;
    }
    return false;
  }

  async analyzeMarket(params: {
    skillContent: string;
    marketData: MarketSummary;
    positions: { instId: string; posSide: string; avgPx: string; upl: string }[];
    account: { totalEq: string };
    tradeHistory: TradeRecord[];
    fallbackSymbol?: string;
  }): Promise<AIDecision> {
    const { skillContent, marketData, positions, account, tradeHistory, fallbackSymbol = "BTCUSDT" } = params;

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(skillContent) },
      { role: "user", content: buildUserPrompt(marketData, positions, account, tradeHistory) },
    ];

    const startProviderIdx = this.currentProviderIndex;
    const startProvider = this.currentProvider;

    let raw = "";
    let attemptProviderIdx = startProviderIdx;

    try {
      raw = await chatComplete(startProvider.config, messages, TIMEOUT_MS);

      // Success: reset failure counter for this provider
      startProvider.consecutiveFailures = 0;

      // Recovery logic: if using backup provider and got success, increment recovery counter
      if (this.currentProviderIndex > 0) {
        this.recoveryCounter++;
        if (this.recoveryCounter >= RECOVERY_THRESHOLD) {
          this.attemptRecoveryToPrimary();
          this.recoveryCounter = 0;
        }
      } else {
        // Using primary, reset recovery counter
        this.recoveryCounter = 0;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failedProvider = this.providers[attemptProviderIdx];

      console.warn(`[AI Engine] ${failedProvider.type} failed (${msg})`);

      // Increment failure counter for current provider
      failedProvider.consecutiveFailures++;

      // Try next provider if current one exceeded failure threshold
      if (failedProvider.consecutiveFailures >= FAILURE_THRESHOLD) {
        if (this.switchToNextProvider()) {
          // Successfully switched, try the next provider
          attemptProviderIdx = this.currentProviderIndex;
          try {
            raw = await chatComplete(this.currentProvider.config, messages, TIMEOUT_MS);
            // Success on backup provider
            this.currentProvider.consecutiveFailures = 0;
            // Reset recovery counter for primary if we're back on it
            if (this.currentProviderIndex === 0) {
              this.recoveryCounter = 0;
            }
          } catch (err2) {
            const msg2 = err2 instanceof Error ? err2.message : String(err2);
            console.error(`[AI Engine] ${this.currentProvider.type} also failed (${msg2})`);
            this.currentProvider.consecutiveFailures++;

            // All providers exhausted
            if (this.currentProviderIndex >= this.providers.length - 1) {
              return {
                action: "HOLD",
                instrument: fallbackSymbol,
                confidence: 0,
                reasoning: `AI请求全部失败: ${msg2}`,
                model_used: this.currentProvider.type,
              };
            }
            return {
              action: "HOLD",
              instrument: fallbackSymbol,
              confidence: 0,
              reasoning: `AI请求失败: ${msg2}`,
              model_used: this.currentProvider.type,
            };
          }
        } else {
          // No more providers to try
          return {
            action: "HOLD",
            instrument: fallbackSymbol,
            confidence: 0,
            reasoning: `AI请求失败: ${msg}`,
            model_used: failedProvider.type,
          };
        }
      } else {
        return {
          action: "HOLD",
          instrument: fallbackSymbol,
          confidence: 0,
          reasoning: `AI请求失败: ${msg}`,
          model_used: failedProvider.type,
        };
      }
    }

    const decision = parseAIDecision(raw, fallbackSymbol);
    decision.model_used = this.currentProvider.type;

    console.log(
      `[AI Engine] → ${decision.action} ${decision.instrument} ` +
        `(conf=${decision.confidence} model=${decision.model_used})`,
    );

    return decision;
  }
}
