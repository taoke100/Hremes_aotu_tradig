/**
 * Exchange Router — Unified API for Binance and OKX
 *
 * trader.ts imports from here instead of directly from binance.ts.
 * At runtime, the Trader class reads its exchange config and calls
 * the appropriate exchange implementation.
 *
 * 设计原则：
 *   - 所有函数签名与 binance.ts 完全一致
 *   - OKX symbol 格式：BTC-USDT-SWAP（normalize() 负责转换）
 *   - 错误时统一抛异常，由 trader.ts 的 try/catch 捕获
 */
import * as binance from "./binance.js";
import * as okx from "./okx.js";
import type {
  AIDecision,
  BinanceBalance,
  BinanceKline,
  BinancePosition,
  BinanceTicker,
  MarketSummary,
  BinanceOrderResult,
  BinanceAlgoOrderResult,
  SystemConfig,
} from "./types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Hardcode BASE_DIR to avoid import.meta in ESM tsconfig lint
const BASE_DIR = join(process.cwd(), "data");
const SYSTEM_CONFIG_FILE = join(process.cwd(), "data", "system_config.json");

// ── Exchange Config Loader ───────────────────────────────────

interface ExchangeCreds {
  apiKey: string;
  secretKey: string;
  passphrase?: string; // OKX 专用
  isDemo?: boolean;
}

function _loadExchanges(): Record<string, ExchangeCreds> {
  try {
    const cfg = JSON.parse(readFileSync(SYSTEM_CONFIG_FILE, "utf-8")) as SystemConfig;
    const out: Record<string, ExchangeCreds> = {};

    if (cfg.exchanges) {
      for (const [key, ex] of Object.entries(cfg.exchanges)) {
        if (key === "binance") {
          out[key] = {
            apiKey: (ex as { api_key?: string; apiKey?: string }).apiKey ?? "",
            secretKey: (ex as { secret_key?: string; secretKey?: string }).secretKey ?? "",
          };
        } else {
          // OKX
          out[key] = {
            apiKey: (ex as { api_key?: string; apiKey?: string }).apiKey ?? "",
            secretKey: (ex as { secret_key?: string; secretKey?: string }).secretKey ?? "",
            passphrase: (ex as { passphrase?: string }).passphrase ?? "",
            isDemo: (ex as { is_demo?: boolean; isDemo?: boolean }).isDemo ?? false,
          };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ── Per-trader exchange instance ──────────────────────────────

export interface ExchangeAPI {
  getBalance(ccy?: string): Promise<BinanceBalance | null>;
  getPositions(): Promise<BinancePosition[]>;
  getMarketSummary(instruments: string[]): Promise<MarketSummary>;
  getTopGainers(
    minVolume?: number,
    topN?: number,
    minPrice?: number,
    maxPrice?: number,
  ): Promise<string[]>;
  placeOrder(params: {
    instId: string;
    side: "BUY" | "SELL";
    ordType: "MARKET" | "LIMIT" | "STOP" | "TAKE_PROFIT";
    sz: string;
    px?: string;
    tdMode?: "cross" | "isolated" | "cash" | "spot";
    reduceOnly?: boolean;
  }): Promise<BinanceOrderResult>;
  placeAlgoOrder(params: {
    instId: string;
    side: "BUY" | "SELL";
    sz: string;
    tpTriggerPx?: string;
    slTriggerPx?: string;
  }): Promise<BinanceAlgoOrderResult>;
  setLeverage(symbol: string, lever: number, marginMode?: string): Promise<void>;
  normalize(instId: string): string;
}

/**
 * Get exchange API for a specific trader.
 * Initializes OKX credentials from system_config.json the first time.
 */
export function getExchangeAPI(traderExchange: string): ExchangeAPI {
  const exchanges = _loadExchanges();
  const ex = exchanges[traderExchange];

  if (!ex) {
    console.warn(`[ExchangeRouter] Unknown exchange "${traderExchange}", defaulting to binance`);
    return _binanceAPI();
  }

  if (traderExchange === "binance") {
    return _binanceAPI();
  }

  if (traderExchange.startsWith("okx")) {
    // Initialize OKX credentials
    okx.setOKXCredentials({
      apiKey: ex.apiKey,
      secretKey: ex.secretKey,
      passphrase: ex.passphrase ?? "",
      isDemo: ex.isDemo ?? false,
    });
    return _okxAPI();
  }

  console.warn(`[ExchangeRouter] Unknown exchange "${traderExchange}", defaulting to binance`);
  return _binanceAPI();
}

function _binanceAPI(): ExchangeAPI {
  return {
    async getBalance(ccy?: string) {
      return binance.getBalance(ccy ?? "USDT", true);
    },
    async getPositions() {
      return binance.getPositions();
    },
    async getMarketSummary(instruments: string[]) {
      return binance.getMarketSummary(instruments);
    },
    async getTopGainers(
      minVolume?: number,
      topN?: number,
      minPrice?: number,
      maxPrice?: number,
    ) {
      return binance.getTopGainers(minVolume, topN, minPrice, maxPrice);
    },
    async placeOrder(params) {
      return binance.placeOrder(params);
    },
    async placeAlgoOrder(params) {
      return binance.placeAlgoOrder(params);
    },
    async setLeverage(symbol: string, lever: number, marginMode?: string) {
      return binance.setLeverage(symbol, lever, marginMode ?? "cross");
    },
    normalize(instId: string) {
      return binance.normalize(instId);
    },
  };
}

function _okxAPI(): ExchangeAPI {
  return {
    async getBalance(ccy?: string) {
      return okx.getBalance(ccy ?? "USDT");
    },
    async getPositions() {
      return okx.getPositions();
    },
    async getMarketSummary(instruments: string[]) {
      return okx.getMarketSummary(instruments);
    },
    async getTopGainers(
      minVolume?: number,
      topN?: number,
      minPrice?: number,
      maxPrice?: number,
    ) {
      return okx.getTopGainers(minVolume, topN, minPrice, maxPrice);
    },
    async placeOrder(params) {
      return okx.placeOrder(params) as unknown as BinanceOrderResult;
    },
    async placeAlgoOrder(params) {
      return okx.placeAlgoOrder(params) as unknown as BinanceAlgoOrderResult;
    },
    async setLeverage(symbol: string, lever: number, marginMode?: string) {
      return okx.setLeverage(symbol, lever, marginMode ?? "cross");
    },
    normalize(instId: string) {
      return okx.normalize(instId);
    },
  };
}

// ── Re-export types for convenience ───────────────────────────

export type { BinanceBalance, BinanceKline, BinancePosition, BinanceTicker, MarketSummary };
