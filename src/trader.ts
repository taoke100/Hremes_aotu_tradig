/**
 * AI Trader — Core Trading Logic (TypeScript)
 * Single-process, async event loop with risk guards.
 */
import {
  getBalance,
  getPositions,
  getMarketSummary,
  getTopGainers,
  placeOrder,
  placeAlgoOrder,
  setLeverage,
  normalize,
} from "./binance.js";
import { AIEngine, type AIEngineConfig } from "./ai_engine.js";
import type {
  AIDecision,
  EquityPoint,
  MarketSummary,
  OpenPosition,
  SpotBalancePoint,
  SystemConfig,
  TraderConfig,
  TradeRecord,
  TraderStatus,
} from "./types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BASE_DIR = join(__dirname, "..");
const SESSIONS_DIR = join(BASE_DIR, "data", "sessions");
const SYSTEM_CONFIG_FILE = join(BASE_DIR, "data", "system_config.json");
const DEFAULT_SKILL_FILE = join(BASE_DIR, "docs", "SKILL.md");

const VERSION = "1.2.0";

// ── Helpers ──────────────────────────────────────────────────

const nowStr = () => {
  const d = new Date();
  return d.toISOString().replace("T", " ").slice(0, 19);
};

function loadConfig(): SystemConfig {
  if (existsSync(SYSTEM_CONFIG_FILE)) {
    return JSON.parse(readFileSync(SYSTEM_CONFIG_FILE, "utf-8"));
  }
  return { traders: {}, ai_providers: {}, exchanges: {} };
}

function loadTraderConfig(traderId: string): TraderConfig | null {
  const cfg = loadConfig();
  return cfg.traders[traderId] ?? null;
}

function loadSkillContent(traderInfo: TraderConfig): string {
  if (traderInfo.skill_content) return traderInfo.skill_content;
  if (existsSync(DEFAULT_SKILL_FILE)) return readFileSync(DEFAULT_SKILL_FILE, "utf-8");
  return "默认策略: 趋势跟踪，控制风险，合理止盈止损。";
}

// ── Risk Guard State ────────────────────────────────────────

interface RiskState {
  dailyLossLimitPct: number;
  consecutiveStopLoss: number;
  forceHoldUntil: number | null;
  todayDate: string;
  todayLoss: number;
}

function newRiskState(): RiskState {
  // 参考 nofxai13: dailyLossLimitPct 默认 3%（原硬编码 12% 过高）
  const cfg = { dailyLossLimitPct: 0.03 };
  return {
    dailyLossLimitPct: cfg.dailyLossLimitPct,
    consecutiveStopLoss: 0,
    forceHoldUntil: null,
    todayDate: new Date().toISOString().slice(0, 10),
    todayLoss: 0,
  };
}

// ── Trader Class ────────────────────────────────────────────

export class Trader {
  traderId: string;
  config: TraderConfig;
  risk: RiskState;
  engine: AIEngine;
  watchlist: string[];
  skillContent: string;
  freq: number;
  startBalance: number | null = null;
  equityHistory: EquityPoint[] = [];
  spotBalanceHistory: SpotBalancePoint[] = [];
  events: { time: string; thought?: string; action: string; confidence: number; model?: string }[] = [];
  trades: TradeRecord[] = [];
  systemStartTime: string;
  statusFilePath: string;
  thinkingFilePath: string;
  tradesFilePath: string;
  running = false;

  constructor(traderId: string) {
    const cfg = loadTraderConfig(traderId);
    if (!cfg) throw new Error(`Trader ${traderId} not found in system_config.json`);

    this.traderId = traderId;
    this.config = cfg;
    this.risk = newRiskState();

    // Load per-trader AI provider config from system config
    const systemCfg = loadConfig();
    const providerKey = cfg.ai_provider;
    const providerEntry = systemCfg.ai_providers?.[providerKey];
    if (providerEntry) {
      const engineCfg: AIEngineConfig = {
        apiKey: providerEntry.api_key,
        model: providerEntry.model,
        baseUrl: providerEntry.base_url,
        type: providerEntry.type as "minimax" | "deepseek" | "qwen",
      };
      this.engine = new AIEngine(engineCfg);
    } else {
      this.engine = new AIEngine(); // env-var fallback
    }

    this.watchlist = cfg.watchlist ?? ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    this.skillContent = loadSkillContent(cfg);
    this.freq = cfg.scan_frequency ?? 30;
    this.systemStartTime = nowStr();

    const sessionDir = join(SESSIONS_DIR, traderId);
    mkdirSync(sessionDir, { recursive: true });
    this.statusFilePath = join(sessionDir, "status.json");
    this.thinkingFilePath = join(sessionDir, "thinking.json");
    this.tradesFilePath = join(sessionDir, "trades.json");

    this._loadState();
    console.log(`[Trader:${traderId}] Initialized v${VERSION} | freq=${this.freq}s`);
  }

  private _loadState() {
    if (existsSync(this.statusFilePath)) {
      try {
        const old = JSON.parse(readFileSync(this.statusFilePath, "utf-8"));
        this.equityHistory = old.equity_history ?? [];
        this.spotBalanceHistory = old.spot_balance_history ?? [];
        this.startBalance = old.start_balance ?? null;
      } catch { /* ignore */ }
    }
    if (existsSync(this.thinkingFilePath)) {
      try {
        const old = JSON.parse(readFileSync(this.thinkingFilePath, "utf-8"));
        if (Array.isArray(old)) this.events = old.slice(-20);
      } catch { /* ignore */ }
    }
    if (existsSync(this.tradesFilePath)) {
      try {
        this.trades = JSON.parse(readFileSync(this.tradesFilePath, "utf-8"));
      } catch { /* ignore */ }
    }
  }

  private _saveState(
    account: { totalEq: string; availBal: string },
    positions: { instId: string; pos: string; posSide: string; avgPx: string; upl: string; lever: string; margin: string; markPx: string }[],
    _marketData: MarketSummary,
  ) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // Reset daily risk if new day
    if (today !== this.risk.todayDate) {
      this.risk.todayDate = today;
      this.risk.todayLoss = 0;
      this.risk.consecutiveStopLoss = 0;
      console.log(`[Trader:${this.traderId}] New trading day — risk counters reset`);
    }

    const totalEq = parseFloat(account.totalEq ?? "0");
    const availBal = parseFloat(account.availBal ?? "0");
    const unrealized = positions.reduce((s, p) => s + parseFloat(p.upl ?? "0"), 0);

    if (this.startBalance == null) {
      this.startBalance = totalEq;
    }

    const cfgStart = loadTraderConfig(this.traderId)?.initial_balance;
    if (cfgStart != null && cfgStart !== this.startBalance) {
      this.startBalance = cfgStart;
    }

    const startB = this.startBalance ?? 1;
    const yieldRate = totalEq > 0 ? (totalEq - startB) / startB : 0;
    const totalProfit = totalEq - startB;

    // Sample equity every 60s
    const lastEquity = this.equityHistory.at(-1);
    const sinceLast = lastEquity
      ? (now.getTime() - new Date(lastEquity.time).getTime()) / 1000
      : 9999;

    if (sinceLast >= 60) {
      this.equityHistory.push({ time: nowStr(), balance: availBal, equity: totalEq });
      if (this.equityHistory.length > 480) this.equityHistory.shift();
    }

    // Sample spot balance
    const sinceSpot = (this.spotBalanceHistory.at(-1)
      ? (now.getTime() - new Date(this.spotBalanceHistory.at(-1)!.time).getTime()) / 1000
      : 9999);
    if (sinceSpot >= 60) {
      this.spotBalanceHistory.push({ time: nowStr(), balance: availBal });
      if (this.spotBalanceHistory.length > 480) this.spotBalanceHistory.shift();
    }

    const openPositions: OpenPosition[] = positions.map((p) => ({
      symbol: p.instId,
      direction: p.posSide as "long" | "short",
      amount: Math.abs(parseFloat(p.pos)),
      entryPrice: parseFloat(p.avgPx),
      currentPrice: parseFloat(p.markPx),
      leverage: parseInt(p.lever) || 1,
      unrealizedProfit: parseFloat(p.upl),
      margin: parseFloat(p.margin),
    }));

    const lastEvent = this.events.at(-1);
    const topSignal = lastEvent
      ? {
          symbol: lastEvent.action.includes("LONG")
            ? "BTCUSDT"
            : lastEvent.action.includes("SHORT")
              ? "BTCUSDT"
              : this.watchlist[0] ?? "BTCUSDT",
          direction: lastEvent.action.includes("LONG")
            ? "long"
            : lastEvent.action.includes("SHORT")
              ? "short"
              : "neutral",
          score: lastEvent.confidence,
        }
      : { symbol: this.watchlist[0] ?? "BTCUSDT", direction: "neutral", score: 0 };

    const status: TraderStatus = {
      session_id: this.traderId,
      session_started_at: this.equityHistory[0]?.time ?? nowStr(),
      last_run: nowStr(),
      start_balance: startB,
      balance: availBal,
      equity: totalEq,
      available: availBal,
      unrealized_pnl: unrealized,
      yield_rate: Math.round(yieldRate * 1e6) / 1e6,
      total_profit: Math.round(totalProfit * 100) / 100,
      equity_history: this.equityHistory,
      spot_balance_history: this.spotBalanceHistory,
      positions: positions.length,
      open_positions: openPositions,
      trades_count: this.trades.length,
      mode: "binance-ai-agent-v2",
      exchange: "binance",
      contract_type: "U本位永续",
      system_start_time: this.systemStartTime,
      watchlist: this.watchlist,
      top_signal: topSignal,
      strategy_v2: {
        name: this.config.name ?? "Binance AI Strategy",
        entryLogic: "MiniMax AI 分析决策",
        riskGuard: "SKILL.md 风控规则",
      },
      strategy_params: {
        take_profit: "+30%卖50% / +50%卖80%",
        stop_loss: "买入价-5%止损",
        leverage: "3x 永续",
        entry_logic: "RSI+价格形态+成交量+趋势四维信号",
      },
      events: this.events.map((e) => e.thought ?? e.action).slice(-10),
      source: "minimax_ai",
    };

    writeFileSync(this.statusFilePath, JSON.stringify(status, null, 2), "utf-8");
    writeFileSync(
      this.thinkingFilePath,
      JSON.stringify(this.events.slice(-30), null, 2),
      "utf-8",
    );
    writeFileSync(this.tradesFilePath, JSON.stringify(this.trades.slice(-500), null, 2), "utf-8");
  }

  // ── Risk Guard ────────────────────────────────────────────

  private _checkRiskGuard(
    account: { totalEq: string },
    positions: { instId: string; pos: string; upl: string; avgPx: string; margin: string; posSide: string }[],
  ): { hold: boolean; reason: string } {
    const now = Date.now();
    const totalEq = parseFloat(account.totalEq ?? "0");
    const startB = this.startBalance ?? 1;

    // Update today's loss
    const dailyPnl = totalEq - startB;
    if (dailyPnl < 0) {
      this.risk.todayLoss = Math.min(this.risk.todayLoss + Math.abs(dailyPnl), this.risk.todayLoss);
    }

    // 1. Force HOLD window
    if (this.risk.forceHoldUntil && now < this.risk.forceHoldUntil) {
      const remain = Math.ceil((this.risk.forceHoldUntil - now) / 1000);
      return { hold: true, reason: `风控熔断中，强制休息 ${remain}s（连续止损惩罚）` };
    }

    // 2. Daily loss circuit breaker (>12%)
    if (this.risk.todayLoss > 0 && startB > 0) {
      const lossPct = this.risk.todayLoss / startB;
      if (lossPct >= this.risk.dailyLossLimitPct) {
        this.risk.forceHoldUntil = now + 86400 * 1000; // rest of the day
        return {
          hold: true,
          reason: `日亏 ${this.risk.todayLoss.toFixed(2)} USDT (${(lossPct * 100).toFixed(1)}%)，触发熔断`,
        };
      }
    }

    // 3. Already in position → hold for new entry
    if (positions.length > 0) {
      return { hold: true, reason: `已有持仓中（${positions.length}个标的），优先持仓管理` };
    }

    return { hold: false, reason: "" };
  }

  // ── Position Management ──────────────────────────────────

  private _checkPositionManagement(
    positions: { instId: string; pos: string; upl: string; avgPx: string; margin: string; posSide: string; markPx?: string; leverage?: string }[],
    marketData: MarketSummary,
  ): AIDecision | null {
    if (positions.length === 0) return null;

    for (const p of positions) {
      const posVal = parseFloat(p.pos);
      if (posVal === 0) continue;

      const direction = posVal > 0 ? "long" : "short";
      const entryPx = parseFloat(p.avgPx);
      const markPx = parseFloat(p.markPx ?? "0");
      const margin = parseFloat(p.margin) || 1;
      const upl = parseFloat(p.upl);

      if (entryPx <= 0 || markPx <= 0) continue;

      const uplRatio = margin > 0 ? upl / margin : 0;
      const sym = p.instId;
      const fr = marketData[sym]?.fundingRate;

      // Take-profit: upl/margin >= 100%
      if (uplRatio >= 1.0) {
        return {
          action: direction === "long" ? "CLOSE_LONG" : "CLOSE_SHORT",
          instrument: sym,
          confidence: 0.95,
          reasoning: `浮盈/保证金=${(uplRatio * 100).toFixed(0)}%≥100%，触发止盈保护`,
          size: Math.abs(posVal),
        };
      }

      // Extreme take-profit: >= 200%
      if (uplRatio >= 2.0) {
        return {
          action: direction === "long" ? "CLOSE_LONG" : "CLOSE_SHORT",
          instrument: sym,
          confidence: 0.99,
          reasoning: `浮盈/保证金=${(uplRatio * 100).toFixed(0)}%≥200%，极端止盈`,
          size: Math.abs(posVal),
        };
      }

      // Stop-loss: upl/margin <= -50%（参考 nofxai13 StopLossPct，默认更严格）
      // 若交易员配置了 stop_loss_pct 则优先使用
      const slThreshold = this.config.stop_loss_pct ?? -0.5;
      if (uplRatio <= slThreshold) {
        return {
          action: direction === "long" ? "CLOSE_LONG" : "CLOSE_SHORT",
          instrument: sym,
          confidence: 0.95,
          reasoning: `浮盈/保证金=${(uplRatio * 100).toFixed(0)}%≤-60%，触发软止损`,
          size: Math.abs(posVal),
        };
      }

      // Funding rate squeeze (short only)
      if (direction === "short" && fr != null && fr < -0.005) {
        return {
          action: "CLOSE_SHORT",
          instrument: sym,
          confidence: 0.90,
          reasoning: `资金费率${(fr * 100).toFixed(2)}%<-0.5%，轧空风险平仓`,
          size: Math.abs(posVal),
        };
      }
    }

    return null;
  }

  private _updateStopLossCount() {
    const recent = this.trades.filter(
      (t) => t.tradeAction === "CLOSE" && t.pnl < 0,
    );
    if (recent.length >= 3) {
      this.risk.consecutiveStopLoss = 3;
      this.risk.forceHoldUntil = Date.now() + 3 * 3600 * 1000;
      console.warn(`[Trader:${this.traderId}] 连续3次止损，强制HOLD 3小时`);
    } else {
      this.risk.consecutiveStopLoss = Math.max(0, this.risk.consecutiveStopLoss - 1);
    }
  }

  // ── Execute Decision ──────────────────────────────────────

  private async _executeDecision(
    decision: AIDecision,
    _account: { totalEq: string },
    marketData: MarketSummary,
  ): Promise<{ success: boolean; error?: string }> {
    if (decision.action === "HOLD") return { success: true };

    const instId = normalize(decision.instrument ?? "");
    const leverage = decision.leverage ?? this.config.default_leverage ?? 3;

    try {
      await setLeverage(instId, leverage);

      if (decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT") {
        const side = decision.action === "OPEN_LONG" ? "BUY" : "SELL";
        const lastPx = parseFloat(marketData[instId]?.ticker?.last ?? "0");
        const totalEq = parseFloat(_account.totalEq ?? "0");
        const MIN_NOTIONAL = 5.0;

        // Calculate size
        let rawQty: number;
        if (decision.size && decision.size > 0) {
          rawQty = Math.max(1, Math.round(decision.size));
        } else {
          // Notional = equity × position_size_pct% × leverage
          // 参考 nofxai13: position_size_pct 默认 3%（可配置）
          const sizePct = this.config.position_size_pct ?? 0.03;
          const notional = Math.max(totalEq * sizePct * leverage, MIN_NOTIONAL);
          rawQty = lastPx > 0 ? Math.max(1, Math.round(notional / lastPx)) : 1;
        }

        const result = await placeOrder({
          instId,
          side,
          ordType: "MARKET",
          sz: String(rawQty),
          tdMode: "cross",
        });

        if (result.code) {
          return { success: false, error: result.msg ?? `Code ${result.code}` };
        }

        const avgPx = parseFloat(String(result.avgPrice ?? 0));
        const executedQty = parseFloat(String(result.executedQty ?? 0));

        // Set TP/SL algo orders after opening
        const slPx = decision.stop_loss;
        const tpPx = decision.take_profit;
        if ((slPx || tpPx) && avgPx > 0) {
          const algoSide: "BUY" | "SELL" = decision.action === "OPEN_LONG" ? "SELL" : "BUY";
          try {
            await placeAlgoOrder({
              instId,
              side: algoSide,
              sz: String(Math.max(1, Math.round(executedQty))),
              tpTriggerPx: tpPx ? String(tpPx) : undefined,
              slTriggerPx: slPx ? String(slPx) : undefined,
            });
            console.log(`[Trader:${this.traderId}] TP/SL placed: SL=${slPx} TP=${tpPx}`);
          } catch (e) {
            console.warn(`[Trader:${this.traderId}] Algo order failed (non-fatal): ${e}`);
          }
        }

        return { success: true };
      }

      if (decision.action === "CLOSE_LONG" || decision.action === "CLOSE_SHORT") {
        const side = decision.action === "CLOSE_LONG" ? "SELL" : "BUY";
        const result = await placeOrder({
          instId,
          side,
          ordType: "MARKET",
          sz: String(decision.size ?? 1),
          tdMode: "cross",
          reduceOnly: true,
        });

        if (result.code) {
          return { success: false, error: result.msg ?? `Code ${result.code}` };
        }

        return { success: true };
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  // ── Main Loop ─────────────────────────────────────────────

  async start() {
    this.running = true;
    console.log(`[Trader:${this.traderId}] Starting main loop (freq=${this.freq}s)`);

    while (this.running) {
      const cycleStart = Date.now();

      try {
        // ── Build dynamic watchlist from 24h gainers ──
        let effectiveWatchlist = [...this.watchlist];
        try {
          const gainers = await getTopGainers(20_000_000, 10, 200, 10);
          if (gainers.length > 0) {
            effectiveWatchlist = gainers;
            console.log(`[Trader:${this.traderId}] Dynamic watchlist (${gainers.length}): ${gainers.join(", ")}`);
          }
        } catch (e) {
          console.warn(`[Trader:${this.traderId}] Gainer scan failed: ${e}`);
        }

        // Inject BTC for macro
        const btcMacro = "BTCUSDT";
        const watchlistWithBtc = effectiveWatchlist.includes(btcMacro)
          ? effectiveWatchlist
          : [btcMacro, ...effectiveWatchlist];

        // ── Fetch all market data CONCURRENTLY ──
        console.log(`[Trader:${this.traderId}] Fetching market data for ${watchlistWithBtc.length} symbols...`);
        const marketData = await getMarketSummary(watchlistWithBtc);
        if (!Object.keys(marketData).length) {
          console.warn(`[Trader:${this.traderId}] No market data, retry next cycle`);
          await this._pushEvent("HOLD", 0, "未能获取市场数据，跳过");
          await this._sleep(Math.max(5, this.freq) * 1000);
          continue;
        }

        // ── Account & Positions ──
        const account = (await getBalance("USDT", true)) ?? { totalEq: "0", availBal: "0" };
        const positions = await getPositions();
        console.log(
          `[Trader:${this.traderId}] Equity=${account.totalEq} | Positions=${positions.length}`,
        );

        // ── Risk Guard ──
        const { hold, reason: holdReason } = this._checkRiskGuard(account, positions);
        if (hold) {
          console.info(`[Trader:${this.traderId}] HOLD — ${holdReason}`);
          await this._pushEvent("HOLD", 0, holdReason);
          this._saveState(account, positions, marketData);
          await this._sleep(Math.max(5, this.freq) * 1000);
          continue;
        }

        // ── Position Management ──
        const posMgmt = this._checkPositionManagement(positions, marketData);
        if (posMgmt) {
          console.info(`[Trader:${this.traderId}] PosMgmt: ${posMgmt.action} ${posMgmt.instrument} — ${posMgmt.reasoning}`);
          const exec = await this._executeDecision(posMgmt, account, marketData);
          if (exec.success) {
            this.trades.push({
              id: String(Date.now()),
              time: nowStr(),
              type: posMgmt.action.includes("LONG") ? "BUY" : "SELL",
              action: posMgmt.action as any,
              symbol: posMgmt.instrument ?? "",
              amount: posMgmt.size ?? 0,
              price: 0,
              leverage: posMgmt.leverage ?? 3,
              direction: posMgmt.action.includes("LONG") ? "long" : "short",
              tradeAction: "CLOSE",
              reason: posMgmt.reasoning ?? "",
              confidence: posMgmt.confidence ?? 0,
              pnl: 0,
              orderId: "managed",
            });
            this._updateStopLossCount();
          }
          await this._sleep(2000);
          const newAccount = (await getBalance("USDT", true)) ?? account;
          const newPositions = await getPositions();
          this._saveState(newAccount, newPositions, marketData);
          await this._sleep(Math.max(5, this.freq) * 1000);
          continue;
        }

        // ── AI Decision ──
        console.info(`[Trader:${this.traderId}] Requesting AI decision...`);
        let decision = await this.engine.analyzeMarket({
          skillContent: this.skillContent,
          marketData,
          positions,
          account,
          tradeHistory: this.trades.slice(-10),
          fallbackSymbol: this.watchlist[0],
        });

        await this._pushEvent(
          decision.action,
          decision.confidence,
          decision.reasoning ?? "",
          decision.model_used,
        );

        // ── Risk Guard: AI 置信度门槛（参考 nofxai13 MinConfidence=75%） ──
        const minConf = this.config.min_confidence ?? 0.75;
        if (decision.confidence < minConf) {
          console.warn(
            `[Trader:${this.traderId}] AI confidence=${decision.confidence.toFixed(2)} < ${minConf}，忽略信号`,
          );
          decision = { action: "HOLD" } as AIDecision;
        }

        // ── Risk Guard: 最大持仓数限制（参考 nofxai13 MaxPositions=3） ──
        if (decision.action.includes("OPEN")) {
          const maxPos = this.config.max_positions ?? 3;
          const currentPosCount = positions.filter((p) => parseFloat(p.pos) !== 0).length;
          if (currentPosCount >= maxPos) {
            console.warn(
              `[Trader:${this.traderId}] 当前持仓${currentPosCount} >= 限制${maxPos}，禁止开新仓`,
            );
            decision = { action: "HOLD" } as AIDecision;
          }
        }

        // ── Execute Trade ──
        if (decision.action !== "HOLD") {
          console.info(
            `[Trader:${this.traderId}] Executing: ${decision.action} ${decision.instrument} ` +
              `conf=${decision.confidence.toFixed(2)} lever=${decision.leverage ?? this.config.default_leverage ?? 3}`,
          );

          const exec = await this._executeDecision(decision, account, marketData);
          const tradeRecord: TradeRecord = {
            id: String(Date.now()),
            time: nowStr(),
            type: decision.action.includes("LONG") ? "BUY" : "SELL",
            action: decision.action,
            symbol: decision.instrument ?? "",
            amount: decision.size ?? 1,
            price: 0,
            leverage: decision.leverage ?? 3,
            direction: decision.action.includes("LONG") ? "long" : "short",
            tradeAction: decision.action.includes("OPEN") ? "OPEN" : "CLOSE",
            reason: decision.reasoning ?? "",
            confidence: decision.confidence,
            pnl: 0,
            orderId: "pending",
          };

          if (!exec.success) {
            tradeRecord.error = exec.error;
            console.error(`[Trader:${this.traderId}] Trade failed: ${exec.error}`);
          } else {
            console.info(`[Trader:${this.traderId}] Trade executed: ${decision.action}`);
          }

          this.trades.push(tradeRecord);

          // Refresh account
          await this._sleep(2000);
        }

        const finalAccount = (await getBalance("USDT", true)) ?? account;
        const finalPositions = await getPositions();
        this._saveState(finalAccount, finalPositions, marketData);

      } catch (e) {
        console.error(`[Trader:${this.traderId}] Cycle error: ${e}`);
        await this._pushEvent("ERROR", 0, `异常: ${String(e)}`);
      }

      const elapsed = (Date.now() - cycleStart) / 1000;
      const sleepMs = Math.max(5, this.freq - elapsed) * 1000;
      console.info(`[Trader:${this.traderId}] Cycle done in ${elapsed.toFixed(1)}s, sleeping ${(sleepMs / 1000).toFixed(1)}s`);
      await this._sleep(sleepMs);
    }
  }

  stop() {
    this.running = false;
    console.log(`[Trader:${this.traderId}] Stopped`);
  }

  private async _pushEvent(
    action: string,
    confidence: number,
    thought: string,
    model?: string,
  ) {
    this.events.push({ time: nowStr(), action, confidence, thought, model });
    if (this.events.length > 100) this.events.shift();
  }

  private _sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }
}

// ── CLI Entry ───────────────────────────────────────────────

const traderId = process.argv.at(-1);
if (!traderId || traderId.startsWith("-")) {
  console.error("Usage: bun run trader.ts <trader_id>");
  process.exit(1);
}

const trader = new Trader(traderId);

process.on("SIGTERM", () => trader.stop());
process.on("SIGINT", () => trader.stop());

trader.start().catch((e) => {
  console.error(`[Trader:${traderId}] Fatal: ${e}`);
  process.exit(1);
});
