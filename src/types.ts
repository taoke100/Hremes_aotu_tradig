// ============================================================
// Shared TypeScript Types — AI Trading Bot
// ============================================================

// ── Exchange Types ──────────────────────────────────────────

export interface BinanceTicker {
  symbol?: string;
  lastPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  priceChange: string;
  priceChangePercent: string;
  bidPrice: string;
  askPrice: string;
  openPrice: string;
}

export interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
}

export interface BinanceBalanceDetail {
  asset: string;
  availableBalance: string;
  walletBalance: string;
  crossUnPnl: string;
}

export interface BinanceBalance {
  totalEq: string;
  availBal: string;
  walletBalance: string;
  crossUnPnl: string;
  marginBalance: string;
  availableBalance: string;
  details: BinanceBalanceDetail[];
}

export interface BinanceBalanceDetail {
  asset: string;
  availableBalance: string;
  walletBalance: string;
  crossUnPnl: string;
}

export interface BinancePosition {
  instId: string;
  symbol: string;
  pos: string;
  posSide: "long" | "short";
  avgPx: string;
  upl: string;
  lever: string;
  margin: string;
  markPx: string;
}

export interface BinanceOrderResult {
  orderId: number | string;
  executedQty: string;
  avgPrice: string;
  code?: number;
  msg?: string;
  status?: string;
  type?: string;
  side?: string;
}

export interface BinanceAlgoOrderResult {
  orderId: number | string;
  code?: number;
  msg?: string;
}

// ── Market Data ─────────────────────────────────────────────

export interface MarketTicker {
  last: string;
  high24h: string;
  low24h: string;
  vol24h: string;
  quoteVol24h: string;
  change24h: string;
  changePct24h: string;
  bidPx: string;
  askPx: string;
  openPrice: string;
}

export interface MarketData {
  ticker?: MarketTicker;
  candles_1h?: BinanceKline[];
  candles_4h?: BinanceKline[];
  rsi_1h?: number;
  rsi_6_1h?: number;
  rsi_4h?: number;
  rsi_6_4h?: number;
  fundingRate?: number;
  nextFundingTime?: number;
  openInterest?: number;
}

export type MarketSummary = Record<string, MarketData>;

// ── AI Decision ─────────────────────────────────────────────

export type TradeAction =
  | "HOLD"
  | "OPEN_LONG"
  | "OPEN_SHORT"
  | "CLOSE_LONG"
  | "CLOSE_SHORT";

export interface AIDecision {
  action: TradeAction;
  instrument?: string;
  confidence: number;
  reasoning?: string;
  size?: number;
  leverage?: number;
  stop_loss?: number;
  take_profit?: number;
  model_used?: string;
}

export interface AI思考Event {
  time: string;
  thought?: string;
  action: TradeAction;
  instrument?: string;
  confidence: number;
  model?: string;
  leverage?: number;
  size?: number;
  reasoning?: string;
}

// ── Trade Record ────────────────────────────────────────────

export interface TradeRecord {
  id: string;
  time: string;
  type: "BUY" | "SELL";
  action: TradeAction;
  symbol: string;
  amount: number;
  price: number;
  leverage: number;
  direction: "long" | "short";
  tradeAction: "OPEN" | "CLOSE";
  reason: string;
  confidence: number;
  pnl: number;
  orderId: string;
  error?: string;
}

// ── Trader State ────────────────────────────────────────────

export interface EquityPoint {
  time: string;
  balance: number;
  equity: number;
}

export interface SpotBalancePoint {
  time: string;
  balance: number;
}

export interface OpenPosition {
  symbol: string;
  direction: "long" | "short";
  amount: number;
  entryPrice: number;
  currentPrice: number;
  leverage: number;
  unrealizedProfit: number;
  margin: number;
}

export interface TraderStatus {
  session_id: string;
  session_started_at: string;
  last_run: string;
  start_balance: number;
  balance: number;
  equity: number;
  available: number;
  unrealized_pnl: number;
  yield_rate: number;
  total_profit: number;
  equity_history: EquityPoint[];
  spot_balance_history: SpotBalancePoint[];
  positions: number;
  open_positions: OpenPosition[];
  trades_count: number;
  mode: string;
  exchange: string;
  contract_type: string;
  system_start_time: string;
  watchlist: string[];
  top_signal: {
    symbol: string;
    direction: string;
    score: number;
  };
  strategy_v2: {
    name: string;
    entryLogic: string;
    riskGuard: string;
  };
  strategy_params: {
    take_profit: string;
    stop_loss: string;
    leverage: string;
    entry_logic: string;
  };
  events: string[];
  source: string;
}

// ── Config Types ────────────────────────────────────────────

export interface TraderConfig {
  name: string;
  exchange: string; // "binance" | "okx_Ag" | "okx" | etc.
  ai_provider: string;
  watchlist?: string[];
  scan_frequency: number;
  skill_content?: string;
  skill_filename?: string;
  initial_balance?: number;
  // 交易模式：futures=永续合约（默认），spot=现货
  trading_mode?: "futures" | "spot";
  // 风控参数（参考 nofxai13）
  max_positions?: number;        // 最大同时持仓数，默认 3
  max_position_value_pct?: number; // 单仓价值上限（% equity），默认 50
  max_margin_usage_pct?: number;  // 最大保证金使用率，默认 80
  stop_loss_pct?: number;         // 止损%（浮亏/保证金），默认 -50
  take_profit_pct?: number;       // 止盈%（浮盈/保证金），默认 100
  max_drawdown_pct?: number;      // 最大回撤%，默认 5
  daily_loss_limit_pct?: number;  // 日亏损熔断%，默认 3
  min_confidence?: number;        // 最小AI置信度，0-1，默认 0.75
  min_risk_reward_ratio?: number; // 最小盈亏比，默认 2.0
  default_leverage?: number;      // 默认杠杆，默认 3
  position_size_pct?: number;     // 每次开仓仓位%（equity），默认 3
}

export interface AIProviderConfig {
  type: "minimax" | "deepseek" | "qwen";
  api_key: string;
  base_url: string;
  model: string;
}

export interface SystemConfig {
  traders: Record<string, TraderConfig>;
  ai_providers: Record<string, AIProviderConfig>;
  exchanges: Record<string, Record<string, string>>;
  web_brand?: string;
  web_title?: string;
}

// ── API Types ───────────────────────────────────────────────

export interface TraderInfo {
  pid: number;
  status: "running" | "stopped";
}

export interface HealthStatus {
  server: string;
  traders: Record<string, TraderInfo>;
  uptime: number;
}
