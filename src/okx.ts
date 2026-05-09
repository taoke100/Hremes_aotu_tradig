/**
 * OKX REST API v5 Client — TypeScript
 * 接口与 binance.ts 完全对齐，trader.ts 无需改动即可切换交易所。
 *
 * OKX API 签名（与 Python okx_client.py 等效）：
 *   sign = Base64(HMAC-SHA256(secret_key, timestamp + method + path + body))
 *   timestamp = ISO 8601 格式（精度到毫秒）
 */
import * as crypto from "node:crypto";
import { fetch } from "undici";
import type {
  BinanceBalance,
  BinanceBalanceDetail,
  BinanceKline,
  BinancePosition,
  BinanceTicker,
  MarketSummary,
} from "./types.js";

// ── Credentials（运行时从 system_config.json 读取）─────────────

interface OKXCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  isDemo: boolean;
}

let _creds: OKXCredentials = {
  apiKey: "",
  secretKey: "",
  passphrase: "",
  isDemo: false,
};

export function setOKXCredentials(creds: OKXCredentials): void {
  _creds = creds;
}

function _getCreds(): OKXCredentials {
  return _creds;
}

// ── URL ──────────────────────────────────────────────────────

const BASE_URL = "https://www.okx.com"; // 实盘
const DEMO_URL = "https://www.okx.com";  // 模拟共享 URL，OKX 模拟盘用同一域名

function _baseUrl(): string {
  return _getCreds().isDemo ? DEMO_URL : BASE_URL;
}

// ── Auth ─────────────────────────────────────────────────────

function _isoTime(): string {
  const now = new Date();
  return now.toISOString(); // OKX expects ISO 8601 with Z suffix
}

function _sign(timestamp: string, method: string, path: string, body: string): string {
  const msg = timestamp + method + path + body;
  return crypto.createHmac("sha256", _getCreds().secretKey).update(msg).digest("base64");
}

function _authHeaders(method: string, path: string, body = ""): Record<string, string> {
  const creds = _getCreds();
  const timestamp = _isoTime();
  const sign = _sign(timestamp, method, path, body);
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": creds.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": creds.passphrase,
    "Accept": "application/json",
    // is_demo 参数放在 query 而非 header
  };
}

// ── Core HTTP ─────────────────────────────────────────────────

async function _get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${_baseUrl()}${path}${qs ? "?" + qs : ""}`;
  const headers = _authHeaders("GET", path + (qs ? "?" + qs : ""), "");
  const resp = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json();
  if ((data as { code?: string }).code !== "0" && (data as { code?: string }).code !== undefined) {
    throw new Error(`OKX GET ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function _post(
  path: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  const bodyStr = JSON.stringify(body);
  const headers = _authHeaders("POST", path, bodyStr);
  const resp = await fetch(`${_baseUrl()}${path}`, {
    method: "POST",
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json();
  if ((data as { code?: string }).code !== "0" && (data as { code?: string }).code !== undefined) {
    throw new Error(`OKX POST ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// ── Symbol normalization ──────────────────────────────────────

/**
 * Binance symbol (BTCUSDT) → OKX instrument ID (BTC-USDT-SWAP)
 * OKX 永续合约格式：BASE-QUOTE-SWAP
 */
export function normalize(instId: string): string {
  // 已经是 OKX 格式（包含 -）
  if (instId.includes("-")) return instId;
  // 现货格式：USDC-USDT → USDC-USDT-SPOT（暂不支持）
  // 永续格式：BTCUSDT → BTC-USDT-SWAP
  const base = instId.replace(/USDT$/, "").replace(/USD$/, "");
  const quote = instId.endsWith("USDT") ? "USDT" : instId.endsWith("USD") ? "USD" : "USDT";
  // 如果去掉 USDT/USD 后还有剩余，则用 USDT
  const baseClean = instId.replace(/USDT$/, "").replace(/USD$/, "");
  if (!baseClean) return instId; // 本身没有 base，只有 USDT/USD
  return `${baseClean}-${quote}-SWAP`;
}

/**
 * OKX instrument ID → Binance-style symbol
 */
export function toBinanceSymbol(instId: string): string {
  return instId.replace("-SWAP", "").replace("-", "");
}

// ── Ticker ────────────────────────────────────────────────────

export async function getTicker(instId: string): Promise<BinanceTicker | null> {
  const okxId = normalize(instId);
  const data = (await _get("/api/v5/market/ticker", { instId: okxId })) as {
    data?: { last: string; high24h: string; low24h: string; vol24h: string; quoteVol24h: string; bidPx: string; askPx: string; open24h: string; }[];
  };
  const t = data?.data?.[0];
  if (!t) return null;
  return {
    symbol: okxId,
    lastPrice: t.last ?? "0",
    highPrice: t.high24h ?? "0",
    lowPrice: t.low24h ?? "0",
    volume: t.vol24h ?? "0",
    quoteVolume: t.quoteVol24h ?? "0",
    priceChange: String(parseFloat(t.last ?? "0") - parseFloat(t.open24h ?? "0")),
    priceChangePercent: String(
      parseFloat(t.open24h ?? "0") > 0
        ? ((parseFloat(t.last ?? "0") - parseFloat(t.open24h ?? "0")) / parseFloat(t.open24h ?? "0")) * 100
        : 0,
    ),
    bidPrice: t.bidPx ?? "0",
    askPrice: t.askPx ?? "0",
    openPrice: t.open24h ?? "0",
  };
}

// ── Candles ───────────────────────────────────────────────────

export async function getCandles(
  instId: string,
  bar = "1H",
  limit = 100,
): Promise<BinanceKline[]> {
  const okxId = normalize(instId);
  // OKX K线格式：[ts, open, high, low, close, vol, quoteVol]
  const data = (await _get("/api/v5/market/candles", { instId: okxId, bar, limit })) as {
    data?: string[][];
  };
  if (!data?.data) return [];
  return (data.data as string[][]).map((k) => ({
    openTime: parseInt(k[0] ?? "0"),
    open: k[1] ?? "0",
    high: k[2] ?? "0",
    low: k[3] ?? "0",
    close: k[4] ?? "0",
    volume: k[5] ?? "0",
    quoteVolume: k[6] ?? "0",
    closeTime: parseInt(k[0] ?? "0") + 3600_000, // OKX 每根K线持续1小时
  }));
}

// ── RSI (mirrors binance.ts) ──────────────────────────────────

export function computeRSI(candles: BinanceKline[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const closes = candles.map((c) => parseFloat(c.close));
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 1000) / 1000;
}

// ── All SWAP Tickers ──────────────────────────────────────────

export async function getAllSwapTickers(): Promise<BinanceTicker[]> {
  const data = (await _get("/api/v5/market/tickers", { instType: "SWAP" })) as {
    data?: {
      instId: string; last: string; high24h: string; low24h: string;
      vol24h: string; quoteVol24h: string; open24h: string;
    }[];
  };
  if (!data?.data) return [];
  // Filter: only USDT-margined swaps (instId ends with -USDT-SWAP)
  const usdtSwaps = (data.data as {
    instId: string; last: string; high24h: string; low24h: string;
    vol24h: string; quoteVol24h: string; open24h: string;
  }[]).filter((t) => t.instId?.endsWith("-USDT-SWAP"));
  return usdtSwaps.map((t) => ({
    symbol: t.instId,
    lastPrice: t.last ?? "0",
    highPrice: t.high24h ?? "0",
    lowPrice: t.low24h ?? "0",
    volume: t.vol24h ?? "0",
    quoteVolume: t.quoteVol24h ?? "0",
    priceChange: String(parseFloat(t.last ?? "0") - parseFloat(t.open24h ?? "0")),
    priceChangePercent: String(
      parseFloat(t.open24h ?? "0") > 0
        ? ((parseFloat(t.last ?? "0") - parseFloat(t.open24h ?? "0")) / parseFloat(t.open24h ?? "0")) * 100
        : 0,
    ),
    bidPrice: "0",
    askPrice: "0",
    openPrice: t.open24h ?? "0",
  }));
}

// ── Top Gainers ───────────────────────────────────────────────

export async function getTopGainers(
  minVolume = 20_000_000,
  topN = 10,
  minPrice = 0,
  maxPrice = 1e9,
): Promise<string[]> {
  const tickers = await getAllSwapTickers();
  const candidates = tickers
    .filter((t) => {
      const vol = parseFloat(t.quoteVolume ?? "0");
      const price = parseFloat(t.lastPrice ?? "0");
      const chg = parseFloat(t.priceChangePercent ?? "0");
      return vol >= minVolume && price >= minPrice && price <= maxPrice && chg > 0;
    })
    .sort((a, b) => parseFloat(b.priceChangePercent ?? "0") - parseFloat(a.priceChangePercent ?? "0"))
    .slice(0, topN);
  return candidates.map((t) => {
    // OKX: BTC-USDT-SWAP → Binance format: BTCUSDT for normalize()
    return t.symbol?.replace("-USDT-SWAP", "USDT") ?? t.symbol ?? "";
  });
}

// ── Funding Rate ─────────────────────────────────────────────

export async function getFundingRate(instId: string): Promise<{ rate: number; nextTime: string } | null> {
  const okxId = normalize(instId);
  const data = (await _get("/api/v5/market/funding-rate", { instId: okxId })) as {
    data?: { fundingRate: string; nextFundingTime: string }[];
  };
  const f = data?.data?.[0];
  if (!f) return null;
  return {
    rate: parseFloat(f.fundingRate ?? "0"),
    nextTime: f.nextFundingTime ?? "",
  };
}

// ── Open Interest ─────────────────────────────────────────────

export async function getOpenInterest(instId: string): Promise<number | null> {
  const okxId = normalize(instId);
  const data = (await _get("/api/v5/market/open-interest", { instId: okxId })) as {
    data?: { oi: string; oiCcy: string }[];
  };
  const o = data?.data?.[0];
  if (!o) return null;
  // OKX oiCcy = quote currency (USD), oi = contracts count
  // Convert to USD: contracts * contract_val (approx face value = last price)
  // Return the USD value directly if oiCcy === "USD"
  if (o.oiCcy === "USD") return parseFloat(o.oi ?? "0");
  return parseFloat(o.oi ?? "0");
}

// ── Market Summary ─────────────────────────────────────────────

export async function getMarketSummary(instruments: string[]): Promise<MarketSummary> {
  const result: MarketSummary = {};

  // Fetch candles for all instruments in parallel
  await Promise.all(
    instruments.map(async (sym) => {
      try {
        const okxId = normalize(sym);
        const [candles1h, candles4h, ticker, frData] = await Promise.all([
          getCandles(okxId, "1H", 48),
          getCandles(okxId, "4H", 48),
          getTicker(okxId),
          getFundingRate(okxId).catch(() => null),
        ]);

        const rsi6_1h = computeRSI(candles1h.slice(-7), 6);
        const rsi14_1h = computeRSI(candles1h, 14);
        const rsi6_4h = computeRSI(candles4h.slice(-7), 6);
        const fr = frData?.rate ?? null;

        result[sym] = {
          ticker: ticker
            ? {
                last: ticker.lastPrice ?? "0",
                high24h: ticker.highPrice ?? "0",
                low24h: ticker.lowPrice ?? "0",
                vol24h: ticker.volume ?? "0",
                quoteVol24h: ticker.quoteVolume ?? "0",
                change24h: ticker.priceChange ?? "0",
                changePct24h: ticker.priceChangePercent ?? "0",
                bidPx: ticker.bidPrice ?? "0",
                askPx: ticker.askPrice ?? "0",
                openPrice: ticker.openPrice ?? "0",
              }
            : undefined,
          rsi_1h: rsi14_1h ?? null,
          rsi_6_1h: rsi6_1h ?? null,
          rsi_4h: null,
          rsi_6_4h: rsi6_4h ?? null,
          fundingRate: fr,
          nextFundingTime: frData?.nextTime ?? null,
          openInterest: null,
          candles_1h: candles1h,
          candles_4h: candles4h,
        };
      } catch (e) {
        console.warn(`[OKX] getMarketSummary(${sym}) failed: ${e}`);
      }
    }),
  );

  // Cast to MarketSummary — ticker shape (last/bidPx/etc) matches MarketTicker
  return result as MarketSummary;
}

// ── Balance ────────────────────────────────────────────────────

export async function getBalance(ccy = "USDT"): Promise<BinanceBalance | null> {
  // OKX 统一账户：/api/v5/account/balance 返回所有币种
  const data = (await _get("/api/v5/account/balance")) as {
    data?: {
      totalEq: string;
      adjEq: string;
      details: {
        ccy: string; cashBal: string; avail: string; frozen: string;
        ordFroz: string; uTime: string; eq: string; isoEq: string;
        mgnRatio: string; notionalLever: string;
      }[];
    }[];
  };
  const acct = data?.data?.[0];
  if (!acct) return null;

  // 找 USDT 详情
  const usdtDetail = (acct.details ?? []).find((d) => d.ccy === ccy);
  const avail = usdtDetail?.avail ?? "0";
  const totalEq = acct.totalEq ?? acct.adjEq ?? "0";

  const detail: BinanceBalanceDetail = {
    asset: ccy,
    walletBalance: usdtDetail?.cashBal ?? "0",
    availableBalance: avail,
    crossUnPnl: "0",
  };

  return {
    totalEq,
    availBal: avail,
    walletBalance: usdtDetail?.cashBal ?? "0",
    crossUnPnl: "0",
    marginBalance: totalEq,
    availableBalance: avail,
    details: [detail],
  };
}

// ── Positions ──────────────────────────────────────────────────

export async function getPositions(): Promise<BinancePosition[]> {
  // OKX SWAP 持仓：/api/v5/account/positions?instType=SWAP
  const data = (await _get("/api/v5/account/positions", { instType: "SWAP" })) as {
    data?: {
      instId: string; instType: string; posSide: string; pos: string;
      avgPx: string; upl: string; uplRatio: string; lever: string;
      margin: string; notionalUsd: string; mgnMode: string;
      liqPx: string; markPx: string; imr: string; mmr: string;
    }[];
  };
  if (!data?.data) return [];

  const out: BinancePosition[] = [];
  for (const p of data.data) {
    const amt = parseFloat(p.pos ?? "0");
    if (amt === 0) continue;
    // OKX posSide: long/short/net
    const posSide: "long" | "short" = p.posSide === "long" ? "long" : "short";
    out.push({
      instId: p.instId ?? "",
      symbol: toBinanceSymbol(p.instId ?? ""),
      pos: String(amt),
      posSide,
      avgPx: p.avgPx ?? "0",
      upl: p.upl ?? "0",
      lever: p.lever ?? "1",
      margin: p.margin ?? "0",
      markPx: p.markPx ?? "0",
    });
  }
  return out;
}

// ── Leverage ──────────────────────────────────────────────────

export async function setLeverage(
  symbol: string,
  lever: number,
  marginMode = "cross",
): Promise<void> {
  const okxId = normalize(symbol);
  // OKX 设置杠杆：POST /api/v5/account/set-leverage
  // mgnMode: cross / isolated
  await _post("/api/v5/account/set-leverage", {
    instId: okxId,
    lever,
    mgnMode: marginMode,
  });
}

// ── Place Order ────────────────────────────────────────────────

export async function placeOrder(params: {
  instId: string;
  side: "BUY" | "SELL";
  ordType: "MARKET" | "LIMIT" | "STOP" | "TAKE_PROFIT";
  sz: string;
  px?: string;
  tdMode?: "cross" | "isolated" | "cash" | "spot";
  reduceOnly?: boolean;
}): Promise<{
  code: string | number;
  msg: string;
  avgPrice: string;
  executedQty: string;
  orderId?: string;
}> {
  const okxId = normalize(params.instId);
  const side = params.side === "BUY" ? "buy" : "sell";
  const ordType = params.ordType.toLowerCase(); // market/limit/stop/take_profit

  // OKX tdMode: cross / isolated / cash
  let tdMode = params.tdMode ?? "cross";
  if (tdMode === "spot") tdMode = "cash";

  const payload: Record<string, unknown> = {
    instId: okxId,
    tdMode,
    side,
    ordType,
    sz: params.sz,
  };

  if (params.reduceOnly) {
    payload.reduceOnly = true;
  }

  if (params.px && params.ordType !== "MARKET") {
    payload.px = params.px;
  }

  const data = await _post("/api/v5/trade/order", payload);

  const okxResp = data as {
    code: string;
    msg: string;
    data?: { ordId: string; avgPx: string; sz: string; sCode: string; sMsg: string }[];
  };
  if (okxResp.code !== "0" && okxResp.code !== undefined) {
    return { code: okxResp.code, msg: okxResp.msg, avgPrice: "0", executedQty: "0", orderId: "0" };
  }
  const orderData = okxResp.data?.[0];
  return {
    code: okxResp.code,
    msg: orderData?.sMsg ?? okxResp.msg,
    avgPrice: orderData?.avgPx ?? "0",
    executedQty: orderData?.sz ?? params.sz,
    orderId: orderData?.ordId ?? "0",
  };
}

// ── Place Algo Order (TP/SL) ─────────────────────────────────

export async function placeAlgoOrder(params: {
  instId: string;
  side: "BUY" | "SELL";
  sz: string;
  tpTriggerPx?: string;
  slTriggerPx?: string;
}): Promise<{
  code: string | number;
  msg: string;
  orderId?: string;
}> {
  const okxId = normalize(params.instId);
  const side = params.side === "BUY" ? "buy" : "sell";

  if (params.tpTriggerPx && params.slTriggerPx) {
    const [tpResult, slResult] = await Promise.all([
      _placeCondOrder(okxId, side, params.sz, "take_profit", params.tpTriggerPx),
      _placeCondOrder(okxId, side, params.sz, "stop_loss", params.slTriggerPx),
    ]);
    if (tpResult.code !== "0" && String(tpResult.code) !== "0") return tpResult;
    return slResult;
  }

  if (params.tpTriggerPx) {
    return _placeCondOrder(okxId, side, params.sz, "take_profit", params.tpTriggerPx);
  }
  if (params.slTriggerPx) {
    return _placeCondOrder(okxId, side, params.sz, "stop_loss", params.slTriggerPx);
  }

  return { code: "0", msg: "" };
}

async function _placeCondOrder(
  instId: string,
  side: string,
  sz: string,
  ordType: "take_profit" | "stop_loss",
  triggerPx: string,
): Promise<{ code: string | number; msg: string; orderId?: string }> {
  const data = await _post("/api/v5/trade/order-algo", {
    instId,
    side,
    ordType: "conditional",
    sz,
    triggerPx,
    orderPx: "-1",
    tgtCcy: "base_ccy",
  });

  const okxResp = data as {
    code: string;
    msg: string;
    data?: { algoId: string; sCode: string; sMsg: string }[];
  };
  if (okxResp.code !== "0" && okxResp.code !== undefined) {
    return { code: okxResp.code, msg: okxResp.msg };
  }
  return {
    code: okxResp.code,
    msg: okxResp.data?.[0]?.sMsg ?? "",
    orderId: okxResp.data?.[0]?.algoId,
  };
}

// ── Close Position ─────────────────────────────────────────────

export async function closePosition(instId: string): Promise<{ code: string; msg: string }> {
  const okxId = normalize(instId);
  // 获取当前持仓方向
  const positions = await getPositions();
  const pos = positions.find((p) => p.instId === okxId);
  if (!pos) return { code: "0", msg: "no position" };

  const side = pos.posSide === "long" ? "sell" : "buy";
  const data = await _post("/api/v5/trade/close-position", {
    instId: okxId,
    mgnMode: "cross",
    posSide: pos.posSide,
  });

  const okxResp = data as { code: string; msg: string };
  return okxResp;
}
