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
  exchange: "binance" | "okx";
  watchlist: string[];
  scan_frequency: number;
  skill_content?: string;
  initial_balance?: number;
}

export interface SystemConfig {
  traders: Record<string, TraderConfig>;
  deepseek?: {
    type: string;
    model: string;
    base_url: string;
    api_key_env?: string;
  };
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
