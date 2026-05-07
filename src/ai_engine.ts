/**
 * Multi-Provider AI Engine — MiniMax / DeepSeek / Qwen
 * Per-trader config from SystemConfig.ai_providers, env vars as fallback.
 */
import type { AIDecision, MarketSummary, TradeRecord } from "./types.js";

const MINIMAX_KEY = process.env.MINIMAX_API_KEY ?? "";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M2.7";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-chat";
const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

const TIMEOUT_MS = 15_000;
const TIMEOUT_THRESHOLD = 3;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AIConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
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
  private primary: AIEngineConfig;
  private fallback: AIEngineConfig | null = null;
  private consecutiveFailures = 0;
  private useFallback = false;

  /**
   * @param providerConfig  Per-trader AI config from SystemConfig.ai_providers[key].
   *                         If omitted, falls back to env vars (MiniMax primary + DeepSeek fallback).
   */
  constructor(providerConfig?: AIEngineConfig) {
    if (providerConfig) {
      // Per-trader config: use it as primary, DeepSeek env var as automatic fallback
      this.primary = providerConfig;
      if (DEEPSEEK_KEY && providerConfig.type !== "deepseek") {
        this.fallback = {
          apiKey: DEEPSEEK_KEY,
          model: DEEPSEEK_MODEL,
          baseUrl: DEEPSEEK_BASE_URL,
          type: "deepseek",
        };
      }
    } else {
      // Env-var defaults (backward compat)
      this.primary = {
        apiKey: MINIMAX_KEY,
        model: MINIMAX_MODEL,
        baseUrl: MINIMAX_BASE_URL,
        type: "minimax",
      };
      if (DEEPSEEK_KEY) {
        this.fallback = {
          apiKey: DEEPSEEK_KEY,
          model: DEEPSEEK_MODEL,
          baseUrl: DEEPSEEK_BASE_URL,
          type: "deepseek",
        };
      }
    }

    console.log(
      `[AI Engine] Primary=${this.primary.type}/${this.primary.model} Fallback=${this.fallback ? "deepseek" : "none"}`,
    );
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

    const activeConfig = this.useFallback && this.fallback ? this.fallback : this.primary;
    const modelLabel = this.useFallback ? `${this.fallback?.type}-${this.fallback?.model}` : `${this.primary.type}-${this.primary.model}`;

    let raw = "";
    let usedFallback = false;

    try {
      raw = await chatComplete(activeConfig, messages, TIMEOUT_MS);
      this.consecutiveFailures = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (this.fallback && !this.useFallback) {
        console.warn(`[AI Engine] ${this.primary.type} failed (${msg}), switching to fallback`);
        this.consecutiveFailures++;
        this.useFallback = true;
        usedFallback = true;
        raw = await chatComplete(this.fallback, messages, TIMEOUT_MS);
      } else if (this.consecutiveFailures >= TIMEOUT_THRESHOLD && this.fallback) {
        console.warn(`[AI Engine] ${TIMEOUT_THRESHOLD} failures, trying fallback`);
        this.useFallback = true;
        raw = await chatComplete(this.fallback, messages, TIMEOUT_MS);
        usedFallback = true;
      } else {
        this.consecutiveFailures++;
        console.error(`[AI Engine] ${modelLabel} error: ${msg}`);
        return {
          action: "HOLD",
          instrument: fallbackSymbol,
          confidence: 0,
          reasoning: `AI请求失败: ${msg}`,
          model_used: modelLabel,
        };
      }
    }

    const decision = parseAIDecision(raw, fallbackSymbol);
    decision.model_used = modelLabel;

    console.log(
      `[AI Engine] → ${decision.action} ${decision.instrument} ` +
        `(conf=${decision.confidence} model=${decision.model_used})`,
    );

    return decision;
  }
}
