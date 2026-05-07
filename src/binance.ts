/**
 * Binance API Client — TypeScript (undici fetch for Node 22+)
 * Async/concurrent API calls for maximum throughput.
 */
import crypto from "node:crypto";
import { fetch } from "undici";
import type {
  BinanceTicker,
  BinanceKline,
  BinanceBalance,
  BinanceBalanceDetail,
  BinancePosition,
  BinanceOrderResult,
  BinanceAlgoOrderResult,
  MarketSummary,
} from "./types.js";

// ── Credentials ──────────────────────────────────────────────

const BINANCE_API_KEY = process.env.BINANCE_API_KEY ?? "";
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY ?? "";

const BASE_URL = "https://api.binance.com";
const FUTURES_URL = "https://fapi.binance.com";

// ── HMAC Signer ─────────────────────────────────────────────

async function hmacSign(queryString: string, secret: string): Promise<string> {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

function encodeParams(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

// ── Core HTTP ───────────────────────────────────────────────

async function _get(
  path: string,
  params: Record<string, string | number | undefined> = {},
  useFutures = false,
): Promise<unknown> {
  const base = useFutures ? FUTURES_URL : BASE_URL;
  // Public endpoints (klines, ticker, premiumIndex) don't accept timestamp/recvWindow
  const qs = encodeParams(params);
  const url = `${base}${path}?${qs}`;

  const res = await fetch(url, {
    headers: {
      "X-MBX-APIKEY": BINANCE_API_KEY,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`GET ${url} → ${res.status} ${text}`);
  }

  return res.json() as Promise<unknown>;
}

async function _getAuth(
  path: string,
  params: Record<string, string | number | undefined> = {},
  useFutures = false,
): Promise<unknown> {
  const base = useFutures ? FUTURES_URL : BASE_URL;
  const ts = Date.now();
  const fullParams = { ...params, timestamp: ts, recvWindow: 5000 };
  const qs = encodeParams(fullParams);
  const signature = await hmacSign(qs, BINANCE_SECRET_KEY);
  const signedQs = `${qs}&signature=${signature}`;
  const url = `${base}${path}?${signedQs}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-MBX-APIKEY": BINANCE_API_KEY,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`GET ${url} → ${res.status} ${text}`);
  }

  return res.json() as Promise<unknown>;
}

async function _post(
  path: string,
  params: Record<string, string | number | undefined> = {},
  useFutures = false,
): Promise<unknown> {
  const base = useFutures ? FUTURES_URL : BASE_URL;
  const ts = Date.now();
  const fullParams = { ...params, timestamp: ts, recvWindow: 5000 };
  const qs = encodeParams(fullParams);
  const signature = await hmacSign(qs, BINANCE_SECRET_KEY);
  const body = encodeParams({ ...fullParams, signature });

  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": BINANCE_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`POST ${path} → non-JSON: ${text}`);
  }
}

// ── Normalize ────────────────────────────────────────────────

function normalize(symbol: string): string {
  return symbol.replace(/[-_]?(USDT|USDC|USD|BTC|ETH|BNB)$/i, "").toUpperCase() + "USDT";
}

// ── Market Data (public — no signature) ─────────────────────

export async function getTicker(symbol: string): Promise<BinanceTicker | null> {
  try {
    const sym = normalize(symbol);
    const data = (await _get("/api/v3/ticker/24hr", { symbol: sym })) as BinanceTicker;
    return data;
  } catch (err) {
    console.error(`[binance] getTicker error: ${err}`);
    return null;
  }
}

export async function getCandles(
  symbol: string,
  interval: string,
  limit = 30,
): Promise<BinanceKline[]> {
  try {
    const sym = normalize(symbol);
    const raw = (await _get("/api/v3/klines", {
      symbol: sym,
      interval,
      limit,
    })) as unknown[][];

    // Binance kline format: [openTime, O, H, L, C, V, closeTime, ...]
    return raw.map((k) => ({
      openTime: k[0] as number,
      open: k[1] as string,
      high: k[2] as string,
      low: k[3] as string,
      close: k[4] as string,
      volume: k[5] as string,
      closeTime: k[6] as number,
    }));
  } catch (err) {
    console.error(`[binance] getCandles error: ${err}`);
    return [];
  }
}

export async function getAllSwapTickers(): Promise<BinanceTicker[]> {
  try {
    const data = (await _get("/fapi/v1/ticker/24hr", {}, true)) as BinanceTicker[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`[binance] getAllSwapTickers error: ${err}`);
    return [];
  }
}

export async function getTopGainers(
  minVolUsdt = 20_000_000,
  minGainPct = 10.0,
  maxGainPct = 200.0,
  topN = 10,
): Promise<string[]> {
  const tickers = await getAllSwapTickers();
  if (!tickers.length) return [];

  const EXCLUDE = new Set([
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "USDCUSDT",
    "BUSDUSDT", "DAIUSDT", "FDUSDUSDT",
  ]);

  const candidates: { gain: number; vol: number; symbol: string }[] = [];

  for (const t of tickers) {
    const sym = t.symbol ?? "";
    if (EXCLUDE.has(sym)) continue;

    try {
      const last = parseFloat(t.lastPrice ?? "0");
      const open = parseFloat(t.openPrice ?? "0");
      const vol = parseFloat(t.quoteVolume ?? "0");

      if (last <= 0 || open <= 0 || vol < minVolUsdt) continue;

      const gain = ((last - open) / open) * 100;
      if (gain < minGainPct || gain > maxGainPct) continue;

      candidates.push({ gain, vol, symbol: sym });
    } catch {
      // skip
    }
  }

  candidates.sort((a, b) => b.gain - a.gain || b.vol - a.vol);
  const result = candidates.slice(0, topN).map((c) => c.symbol);

  console.log(
    `[binance] Top gainers (${result.length}): ${result.map((s) => {
      const c = candidates.find((x) => x.symbol === s);
      return `${s}(+${c?.gain.toFixed(1)}%)`;
    }).join(", ")}`,
  );

  return result;
}

// ── Funding Rate & Open Interest ────────────────────────────

export async function getFundingRate(symbol: string): Promise<{
  fundingRate: number;
  nextFundingTime: number;
  markPrice: number;
  indexPrice: number;
} | null> {
  try {
    const sym = normalize(symbol);
    const data = (await _get("/fapi/v1/premiumIndex", { symbol: sym }, true)) as Record<string, unknown>;
    return {
      fundingRate: parseFloat(String(data.lastFundingRate ?? 0)),
      nextFundingTime: Number(data.nextFundingTime ?? 0),
      markPrice: parseFloat(String(data.markPrice ?? 0)),
      indexPrice: parseFloat(String(data.indexPrice ?? 0)),
    };
  } catch {
    return null;
  }
}

export async function getOpenInterest(symbol: string): Promise<number | null> {
  try {
    const sym = normalize(symbol);
    const data = (await _get("/fapi/v1/openInterest", { symbol: sym }, true)) as Record<string, unknown>;
    return parseFloat(String(data.openInterest ?? 0));
  } catch {
    return null;
  }
}

// ── RSI Indicator ────────────────────────────────────────────

export function computeRSI(candles: BinanceKline[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const closes = candles.map((c) => parseFloat(c.close));
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss += Math.abs(d);
  }

  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < closes.length - 1; i++) {
    const d = closes[i + 1] - closes[i];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

// ── Market Summary — CONCURRENT fetch (big speedup vs Python) ─

export async function getMarketSummary(instruments: string[]): Promise<MarketSummary> {
  // Fetch ALL tickers in parallel (Python version was sequential!)
  const tickerMap = new Map<string, BinanceTicker | null>();

  await Promise.allSettled(
    instruments.map(async (inst) => {
      tickerMap.set(inst, await getTicker(inst));
    }),
  );

  // Fetch ALL funding rates in parallel
  const frMap = new Map<string, { fundingRate: number; nextFundingTime: number }>();
  await Promise.allSettled(
    instruments.map(async (inst) => {
      const fr = await getFundingRate(inst);
      if (fr) frMap.set(inst, fr);
    }),
  );

  // Fetch 1h + 4h candles + OI for all instruments in parallel
  const [c1hMap, c4hMap, oiMap] = await Promise.all([
    Promise.allSettled(
      instruments.map(async (inst) => ({
        inst,
        candles: await getCandles(inst, "1h", 30),
      })),
    ),
    Promise.allSettled(
      instruments.map(async (inst) => ({
        inst,
        candles: await getCandles(inst, "4h", 30),
      })),
    ),
    Promise.allSettled(
      instruments.map(async (inst) => {
        const oi = await getOpenInterest(inst);
        return { inst, openInterest: oi ?? 0 };
      }),
    ),
  ]);

  const result: MarketSummary = {};

  for (const inst of instruments) {
    const ticker = tickerMap.get(inst) ?? null;
    const fr = frMap.get(inst);
    const r1h = c1hMap
      .filter(
        (r): r is PromiseFulfilledResult<{ inst: string; candles: BinanceKline[] }> =>
          r.status === "fulfilled" && r.value.inst === inst,
      )
      .map((r) => r.value.candles)[0];
    const r4h = c4hMap
      .filter(
        (r): r is PromiseFulfilledResult<{ inst: string; candles: BinanceKline[] }> =>
          r.status === "fulfilled" && r.value.inst === inst,
      )
      .map((r) => r.value.candles)[0];

    const entry: MarketSummary[string] = {};

    if (ticker) {
      entry.ticker = {
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
      };
    }

    if (r1h) {
      entry.candles_1h = r1h;
      entry.rsi_1h = computeRSI(r1h, 14) ?? undefined;
      entry.rsi_6_1h = computeRSI(r1h, 6) ?? undefined;
    }

    if (r4h) {
      entry.candles_4h = r4h;
      entry.rsi_4h = computeRSI(r4h, 14) ?? undefined;
      entry.rsi_6_4h = computeRSI(r4h, 6) ?? undefined;
    }

    if (fr) {
      entry.fundingRate = fr.fundingRate;
      entry.nextFundingTime = fr.nextFundingTime;
    }

    const oiEntry = oiMap.find(
      (r): r is PromiseFulfilledResult<{ inst: string; openInterest: number }> =>
        r.status === "fulfilled" && r.value.inst === inst,
    );
    if (oiEntry) entry.openInterest = oiEntry.value.openInterest;

    result[inst] = entry;
  }

  return result;
}

// ── Account / Balance ───────────────────────────────────────

export async function getBalance(ccy = "USDT", useFutures = false): Promise<BinanceBalance | null> {
  if (useFutures) {
    const data = (await _getAuth("/fapi/v2/balance", {}, true)) as BinanceBalanceDetail[];
    if (!Array.isArray(data)) return null;

    for (const b of data) {
      if (b.asset !== ccy) continue;
      const wallet = parseFloat(b.walletBalance ?? "0");
      const crossPnl = parseFloat(b.crossUnPnl ?? "0");
      return {
        totalEq: String(wallet + crossPnl),
        availBal: b.availableBalance ?? "0",
        walletBalance: b.walletBalance ?? "0",
        crossUnPnl: b.crossUnPnl ?? "0",
        marginBalance: String(wallet + crossPnl),
        availableBalance: b.availableBalance ?? "0",
        details: [b],
      };
    }
    return null;
  }

  // Spot
  const data = (await _getAuth("/api/v3/account", {}, false)) as {
    balances?: { asset: string; free: string; locked: string }[];
  };
  if (!data?.balances) return null;

  for (const b of data.balances) {
    if (b.asset !== ccy) continue;
    return {
      totalEq: b.free,
      availBal: b.free,
      walletBalance: b.free,
      crossUnPnl: "0",
      marginBalance: b.free,
      availableBalance: b.free,
      details: [],
    };
  }
  return null;
}

// ── Positions ────────────────────────────────────────────────

export async function getPositions(): Promise<BinancePosition[]> {
  const data = (await _getAuth("/fapi/v2/positionRisk", { marginAsset: "USDT" }, true)) as {
    symbol: string;
    positionAmt: string;
    entryPrice: string;
    unrealizedProfit: string;
    leverage: string;
    isolatedMargin?: string;
    margin?: string;
    markPrice?: string;
  }[];

  if (!Array.isArray(data)) return [];

  const out: BinancePosition[] = [];
  for (const p of data) {
    const amt = parseFloat(p.positionAmt ?? "0");
    if (amt === 0) continue;
    out.push({
      instId: p.symbol,
      symbol: p.symbol,
      pos: String(amt),
      posSide: amt > 0 ? "long" : "short",
      avgPx: p.entryPrice ?? "0",
      upl: p.unrealizedProfit ?? "0",
      lever: p.leverage ?? "1",
      margin: p.isolatedMargin ?? p.margin ?? "0",
      markPx: p.markPrice ?? "0",
    });
  }
  return out;
}

// ── Leverage ────────────────────────────────────────────────

export async function setLeverage(
  symbol: string,
  lever: number,
  marginMode = "cross",
): Promise<void> {
  const sym = normalize(symbol);
  const mgn = marginMode === "cross" ? "crossedMargin" : "isolatedMargin";
  await _post("/fapi/v1/leverage", { symbol: sym, leverage: lever, marginType: mgn }, true);
}

// ── Place Order ──────────────────────────────────────────────

export async function placeOrder(params: {
  instId: string;
  side: "BUY" | "SELL";
  ordType: "MARKET" | "LIMIT" | "STOP" | "TAKE_PROFIT";
  sz: string;
  px?: string;
  tdMode?: "cross" | "isolated" | "cash" | "spot";
  posSide?: "LONG" | "SHORT";
  reduceOnly?: boolean;
  slTriggerPx?: string;
  slOrdPx?: string;
  tpTriggerPx?: string;
  tpOrdPx?: string;
}): Promise<BinanceOrderResult> {
  const sym = normalize(params.instId);
  const isSpot = ["cash", "spot"].includes(params.tdMode?.toLowerCase() ?? "");

  if (isSpot) {
    const q: Record<string, string | number> = {
      symbol: sym,
      side: params.side,
      type: params.ordType,
      quantity: params.sz,
    };
    if (params.px) {
      q.price = params.px;
      q.timeInForce = "GTC";
    }
    const res = (await _post("/api/v3/order", q)) as BinanceOrderResult;
    return { ...res, avgPrice: String(res.avgPrice ?? 0) };
  }

  // Futures
  const q: Record<string, string | number | undefined> = {
    symbol: sym,
    side: params.side,
    type: params.ordType,
    quantity: params.sz,
  };

  if (params.px) {
    q.price = params.px;
    q.timeInForce = "GTC";
  }
  if (params.posSide) q.positionSide = params.posSide;
  if (params.reduceOnly) q.reduceOnly = "true";

  // Stop-loss / take-profit triggers
  if (params.slTriggerPx) {
    q.stopPrice = params.slTriggerPx;
    q.type = "STOP";
  }
  if (params.tpTriggerPx) {
    q.stopPrice = params.tpTriggerPx;
    q.type = "TAKE_PROFIT";
  }

  const res = (await _post("/fapi/v1/order", q, true)) as BinanceOrderResult;
  return { ...res, avgPrice: String(res.avgPrice ?? 0) };
}

// ── Place Algo Order (TP/SL) ────────────────────────────────

export async function placeAlgoOrder(params: {
  instId: string;
  side: "BUY" | "SELL";
  sz: string;
  tpTriggerPx?: string;
  slTriggerPx?: string;
  tdMode?: string;
}): Promise<BinanceAlgoOrderResult> {
  const sym = normalize(params.instId);
  const isSpot = ["cash", "spot"].includes(params.tdMode?.toLowerCase() ?? "");

  if (isSpot) {
    const q: Record<string, string | number> = {
      symbol: sym,
      side: params.side,
      quantity: params.sz,
    };
    if (params.slTriggerPx) {
      q.stopLossPrice = params.slTriggerPx;
      q.stopLossTimeInForce = "GTC";
    }
    if (params.tpTriggerPx) q.takeProfitPrice = params.tpTriggerPx;

    const res = (await _post("/api/v3/order/oco", q)) as BinanceAlgoOrderResult;
    return res;
  }

  // Futures — set TP and SL as separate orders
  const results: BinanceAlgoOrderResult[] = [];

  if (params.tpTriggerPx) {
    const tpQty = params.slTriggerPx ? String(parseFloat(params.sz) / 2) : params.sz;
    const r1 = (await _post("/fapi/v1/order", {
      symbol: sym,
      side: params.side,
      type: "TAKE_PROFIT",
      quantity: tpQty,
      stopPrice: params.tpTriggerPx,
      timeInForce: "GTC",
    }, true)) as BinanceAlgoOrderResult;
    results.push(r1);
  }

  if (params.slTriggerPx) {
    const slQty = params.tpTriggerPx ? String(parseFloat(params.sz) / 2) : params.sz;
    const r2 = (await _post("/fapi/v1/order", {
      symbol: sym,
      side: params.side,
      type: "STOP",
      quantity: slQty,
      stopPrice: params.slTriggerPx,
      timeInForce: "GTC",
    }, true)) as BinanceAlgoOrderResult;
    results.push(r2);
  }

  return results[0] ?? { orderId: 0 };
}

// ── Close Position ──────────────────────────────────────────

export async function closePosition(instId: string): Promise<BinanceOrderResult | null> {
  const sym = normalize(instId);
  const positions = await getPositions();

  for (const p of positions) {
    if (p.instId !== sym) continue;
    const amt = parseFloat(p.pos ?? "0");
    if (amt === 0) continue;
    const side: "SELL" | "BUY" = amt > 0 ? "SELL" : "BUY";
    return placeOrder({
      instId: sym,
      side,
      ordType: "MARKET",
      sz: String(Math.abs(amt)),
      tdMode: "cross",
      reduceOnly: true,
    });
  }
  return null;
}

export { normalize };
