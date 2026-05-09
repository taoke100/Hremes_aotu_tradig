/**
 * Server — Express API + Static File Server + WebSocket Push (TypeScript)
 *
 * Performance optimizations:
 * - /api/balance: Promise.all 并行 fetch，3 trader ~500ms 而不是 ~1.5s
 * - 静态 import binance.ts/okx.ts：消除热路径 dynamic import 开销
 * - WebSocket 推送：trader IPC → server 内存 → 前端，延迟 <100ms
 * - 文件读异步 + mtime 缓存：解除事件循环阻塞
 * - systemConfig 内存缓存：写时失效
 * - 新闻 RSS 2min TTL 缓存：减少外部调用
 */
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import { fetch as undiciFetch } from "undici";
import { readFile, readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, ChildProcess } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import type { TraderStatus, HealthStatus, TraderInfo } from "./types.js";

// ── Static imports（消除热路径 dynamic import 开销）─────────────
import { getBalance as binanceGetBalance, getMarketSummary } from "./binance.js";
import { getBalance as okxGetBalance } from "./okx.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");
const PUBLIC_DIR = join(BASE_DIR, "public");
const DATA_DIR = join(BASE_DIR, "data");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const SYSTEM_CONFIG_FILE = join(DATA_DIR, "system_config.json");
const SERVER_PORT = parseInt(process.env.PORT ?? "8888");

const TRADERS: Record<string, ChildProcess> = {};
const SERVER_START = Date.now();

// ── In-memory caches ────────────────────────────────────────────

/** systemConfig: 写时失效 */
let _systemConfigCache: SystemConfig | null = null;

interface TraderConfig {
  status?: string;
  name: string;
  exchange: string;
  ai_provider: string;
  watchlist?: string[];
  scan_frequency: number;
  skill_content?: string;
  skill_filename?: string;
  initial_balance?: number;
  trading_mode?: "futures" | "spot" | "swap";
  stop_loss_pct?: number;
  position_size_pct?: number;
  default_leverage?: number;
  min_confidence?: number;
  max_positions?: number;
}
interface SystemConfig {
  traders: Record<string, TraderConfig>;
  ai_providers: Record<string, { type: string; api_key: string; base_url: string; model: string }>;
  exchanges: Record<string, Record<string, string>>;
  web_brand?: string;
  web_title?: string;
}

// ── File content cache (mtime invalidation) ───────────────────
interface FileCacheEntry { mtime: number; data: unknown; }
const _fileCache = new Map<string, FileCacheEntry>();

// ── News cache (2min TTL) ──────────────────────────────────────
let _newsCache: { ts: number; data: unknown } | null = null;
const NEWS_TTL_MS = 2 * 60 * 1000;

// ── Trader in-memory status (IPC → WebSocket) ──────────────────
// Stores latest status/thinking/trades for each trader, refreshed via IPC
const _traderStatusCache: Record<string, unknown> = {};

function _invalidateSystemConfig() {
  _systemConfigCache = null;
}

function loadSystemConfig(): SystemConfig {
  if (_systemConfigCache) return _systemConfigCache;
  try {
    const raw = JSON.parse(readFileSync(SYSTEM_CONFIG_FILE, "utf-8"));
    _systemConfigCache = raw as SystemConfig;
    return _systemConfigCache;
  } catch {
    _systemConfigCache = { traders: {}, ai_providers: {}, exchanges: {} };
    return _systemConfigCache;
  }
}

function saveSystemConfig(updates: Partial<SystemConfig>): void {
  const current = loadSystemConfig(); // reads from cache on subsequent calls
  const merged: SystemConfig = {
    traders: { ...current.traders, ...(updates.traders || {}) },
    ai_providers: { ...current.ai_providers, ...(updates.ai_providers || {}) },
    exchanges: { ...current.exchanges, ...(updates.exchanges || {}) },
    ...(updates.web_brand !== undefined ? { web_brand: updates.web_brand } : {}),
    ...(updates.web_title !== undefined ? { web_title: updates.web_title } : {}),
  };
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SYSTEM_CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
  _invalidateSystemConfig(); // write-through invalidation
}

// ── Env loading ────────────────────────────────────────────────

try {
  const projectEnv = join(BASE_DIR, ".env");
  const hermesEnv = join(process.env.HOME ?? "", ".hermes", ".env");
  for (const envPath of [projectEnv, hermesEnv]) {
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx);
          const val = trimmed.slice(eqIdx + 1);
          if (!(key in process.env)) process.env[key] = val;
        }
      }
    }
  }
  console.log("[Server] Loaded .env credentials");
} catch {
  console.warn("[Server] .env not found, using existing env vars");
}

// ── Express Setup ──────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const upload = multer({ storage: multer.memoryStorage() });

// ── Trader Process Management ──────────────────────────────────

function getTraderEnv() {
  const env = { ...process.env };
  const needed = [
    "BINANCE_API_KEY", "BINANCE_SECRET_KEY",
    "MINIMAX_API_KEY", "MINIMAX_MODEL", "MINIMAX_BASE_URL",
    "DEEPSEEK_API_KEY", "EXCHANGE_TYPE",
  ];
  return Object.fromEntries(Object.entries(env).filter(([k]) => needed.includes(k)));
}

function startTraderProcess(traderId: string): { pid: number } {
  const existing = TRADERS[traderId];
  if (existing && !existing.killed) {
    return { pid: existing.pid ?? 0 };
  }

  const nodePath = process.env.HOME + "/.nvm/versions/node/v24.14.0/bin/node";
  const bunPath = process.env.HOME + "/.bun/bin/bun";

  const useNvm = existsSync(nodePath);
  let useBun = false;
  if (existsSync(bunPath)) {
    try {
      const { execFileSync } = require("child_process");
      execFileSync(bunPath, ["--version"], { timeout: 3000, stdio: "ignore" });
      useBun = true;
    } catch {
      console.warn("[Server] bun binary broken, falling back to node+tsx");
    }
  }

  const execPath = useBun ? bunPath : useNvm ? nodePath : process.execPath;
  const scriptArgs = useBun
    ? [join(__dirname, "trader.ts"), traderId]
    : ["--import", "tsx", join(__dirname, "trader.ts"), traderId];

  const child = spawn(execPath, scriptArgs, {
    stdio: ["ignore", "pipe", "pipe", "ipc"], // add ipc for process.send()
    env: { ...getTraderEnv(), EXCHANGE_TYPE: "binance" },
    detached: false,
  });

  child.stdout?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[${traderId}] ${line}`);
  });

  child.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.error(`[${traderId} ERR] ${line}`);
  });

  // ── IPC: receive trader state updates and broadcast via WebSocket ──
  child.on("message", (msg: unknown) => {
    if (msg && typeof msg === "object" && !Array.isArray(msg)) {
      const m = msg as Record<string, unknown>;
      const traderIdFromMsg = m.traderId as string;
      if (traderIdFromMsg) {
        // Cache in memory
        _traderStatusCache[traderIdFromMsg] = m;
        // Broadcast to all WebSocket clients
        _wsBroadcast(msg);
        // Also refresh file (persist as backup)
        const sessionDir = join(SESSIONS_DIR, traderIdFromMsg);
        if (m.status && existsSync(sessionDir)) {
          writeFileSync(join(sessionDir, "status.json"), JSON.stringify(m.status, null, 2), "utf-8");
        }
        if (m.thinking && existsSync(sessionDir)) {
          writeFileSync(join(sessionDir, "thinking.json"), JSON.stringify(m.thinking, null, 2), "utf-8");
        }
        if (m.trades && existsSync(sessionDir)) {
          writeFileSync(join(sessionDir, "trades.json"), JSON.stringify(m.trades, null, 2), "utf-8");
        }
      }
    }
  });

  child.on("exit", (code) => {
    console.warn(`[${traderId}] Process exited with code ${code}`);
    delete TRADERS[traderId];
  });

  TRADERS[traderId] = child;
  console.log(`[Server] Started ${traderId} (PID ${child.pid})`);
  return { pid: child.pid ?? 0 };
}

function stopTraderProcess(traderId: string): { status: string } {
  const child = TRADERS[traderId];
  if (child && !child.killed) {
    child.kill("SIGTERM");
    delete TRADERS[traderId];
    console.log(`[Server] Stopped ${traderId}`);
  }
  return { status: "stopped" };
}

function getTraderInfo(traderId: string): TraderInfo {
  const child = TRADERS[traderId];
  const cfg = loadSystemConfig();
  const traderCfg = cfg.traders[traderId] ?? {};
  return {
    ...traderCfg,
    pid: child?.pid ?? 0,
    status: child && !child.killed ? "running" : "stopped",
  };
}

// ── WebSocket Server ───────────────────────────────────────────

const _wsClients = new Set<WebSocket>();

function _wsBroadcast(data: unknown) {
  if (_wsClients.size === 0) return;
  const payload = JSON.stringify(data);
  for (const client of _wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ── File cache helper (async + mtime invalidation) ─────────────

function readCachedJson(filePath: string): Promise<unknown> {
  return new Promise((resolve) => {
    readFile(filePath, "utf-8", (err, content) => {
      if (err) { resolve(null); return; }
      try {
        const st = statSync(filePath);
        const cached = _fileCache.get(filePath);
        if (cached && cached.mtime === st.mtimeMs) {
          resolve(cached.data);
          return;
        }
        const data = JSON.parse(content);
        _fileCache.set(filePath, { mtime: st.mtimeMs, data });
        resolve(data);
      } catch {
        resolve(null);
      }
    });
  });
}

// ── API Routes ─────────────────────────────────────────────────

// Health
app.get("/api/health", (_req: Request, res: Response) => {
  const traders: Record<string, TraderInfo> = {};
  const cfg = loadSystemConfig();
  for (const id of Object.keys(cfg.traders as object)) {
    traders[id] = getTraderInfo(id);
  }
  const health: HealthStatus = {
    server: "ok",
    traders,
    uptime: Math.floor((Date.now() - SERVER_START) / 1000),
  };
  res.json(health);
});

// Trader list
app.get("/api/traders", (_req: Request, res: Response) => {
  const cfg = loadSystemConfig();
  const result: Record<string, TraderInfo> = {};
  for (const id of Object.keys(cfg.traders as object)) {
    result[id] = getTraderInfo(id);
  }
  res.json(result);
});

// Create trader
app.post("/api/traders", upload.single("skill_file"), (req: Request, res: Response) => {
  const id = req.body.id as string;
  if (!id || typeof id !== "string" || id.trim() === "") {
    res.status(400).json({ error: "id is required" });
    return;
  }
  const cfg = loadSystemConfig();
  const isUpdate = !!cfg.traders[id];
  if (!isUpdate && cfg.traders[id]) {
    res.status(409).json({ error: `Trader '${id}' already exists` });
    return;
  }
  const skillContent = req.file
    ? req.file.buffer.toString("utf-8")
    : (req.body.skill_content as string | undefined) ?? (isUpdate ? cfg.traders[id]?.skill_content : "");

  cfg.traders[id] = {
    name: (req.body.name as string) ?? (isUpdate ? cfg.traders[id]?.name : id) ?? id,
    exchange: (req.body.exchange as string) ?? (isUpdate ? cfg.traders[id]?.exchange : "binance") ?? "binance",
    trading_mode: (req.body.trading_mode as "futures" | "spot") ?? (isUpdate ? cfg.traders[id]?.trading_mode : "futures") ?? "futures",
    ai_provider: (req.body.ai_provider as string) ?? (isUpdate ? cfg.traders[id]?.ai_provider : "") ?? "",
    scan_frequency: parseInt(req.body.scan_frequency as string) || (isUpdate ? cfg.traders[id]?.scan_frequency : 30) || 30,
    initial_balance: req.body.initial_balance !== undefined
      ? parseFloat(req.body.initial_balance as string)
      : (isUpdate ? cfg.traders[id]?.initial_balance : undefined),
    skill_content: skillContent,
    skill_filename: req.file?.originalname ?? (isUpdate ? cfg.traders[id]?.skill_filename : "") ?? "",
    status: isUpdate ? cfg.traders[id]?.status : "stopped",
  };
  saveSystemConfig(cfg);
  const info = getTraderInfo(id);
  res.json({ result: isUpdate ? "updated" : "created", traderId: id, ...info });
});

// Start trader
app.post("/api/traders/:trader_id/start", (req: Request, res: Response) => {
  const trader_id = String(req.params.trader_id);
  const cfg = loadSystemConfig();
  if (!cfg.traders[trader_id]) {
    res.status(404).json({ error: `Trader ${trader_id} not found in config` });
    return;
  }
  const { pid } = startTraderProcess(String(trader_id));
  res.json({ pid, status: "started" });
});

// Stop trader
app.post("/api/traders/:trader_id/stop", (req: Request, res: Response) => {
  const trader_id = String(req.params.trader_id);
  res.json(stopTraderProcess(trader_id));
});

// Delete trader
app.delete("/api/traders/:trader_id", (req: Request, res: Response) => {
  const trader_id = String(req.params.trader_id);
  stopTraderProcess(trader_id);
  const cfg = loadSystemConfig();
  if (cfg.traders[trader_id]) {
    delete cfg.traders[trader_id];
    console.log(`[DELETE] Deleted ${trader_id}, remaining:`, Object.keys(cfg.traders));
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SYSTEM_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
    _invalidateSystemConfig();
  } else {
    console.log(`[DELETE] ${trader_id} not found in config`);
  }
  res.json({ status: "deleted" });
});

// Get trader skill
app.get("/api/traders/:trader_id/skill", (req: Request, res: Response) => {
  const trader_id = String(req.params.trader_id);
  const cfg = loadSystemConfig();
  const t = cfg.traders[trader_id];
  if (!t) { res.status(404).json({ error: "not found" }); return; }
  res.json({ skill_content: t.skill_content ?? "" });
});

// Update trader skill
app.post("/api/traders/:trader_id/skill", (req: Request, res: Response) => {
  const trader_id = String(req.params.trader_id);
  const { skill_content } = req.body as { skill_content?: string };
  const cfg = loadSystemConfig();
  if (!cfg.traders[trader_id as string]) { res.status(404).json({ error: "not found" }); return; }
  (cfg.traders[trader_id as string] ?? {}).skill_content = skill_content ?? "";
  saveSystemConfig(cfg);
  res.json({ status: "ok" });
});

// System config
app.get("/api/system/config", (_req: Request, res: Response) => {
  res.json(loadSystemConfig());
});

app.post("/api/system/config", (req: Request, res: Response) => {
  const updates = req.body as Partial<SystemConfig>;
  if (!updates || typeof updates !== "object") {
    res.status(400).json({ error: "Invalid config" });
    return;
  }
  saveSystemConfig(updates);
  res.json({ status: "ok" });
});

// ── /api/balance ─────────────────────────────────────────────────
// P0: 串行 → Promise.all 并行，3 trader: ~1.5s → ~500ms
app.get("/api/balance", async (_req: Request, res: Response) => {
  const cfg = loadSystemConfig();
  const traderIds = Object.keys(cfg.traders);

  const results = await Promise.all(
    traderIds.map(async (traderId): Promise<[string, Record<string, unknown>]> => {
      const statusPath = join(SESSIONS_DIR, traderId, "status.json");

      if (existsSync(statusPath)) {
        try {
          const data = await readCachedJson(statusPath);
          if (data && typeof data === "object") {
            const s = data as TraderStatus;
            const trader = cfg.traders[traderId];
            return [traderId, {
              totalEq: s.equity,
              equity: s.equity,
              balance: s.balance,
              total_profit: s.total_profit,
              yield_rate: s.yield_rate,
              unrealized_pnl: s.unrealized_pnl,
              available: s.available,
              accountType: /永续|futures|合约|contract/i.test(s.contract_type || '') ? 'futures' : 'spot',
              positions: s.positions,
              open_positions: (s as unknown as Record<string, unknown>).open_positions,
              exchange: trader?.exchange ?? 'binance',
              trading_mode: trader?.trading_mode ?? 'futures',
            }];
          }
        } catch { /* skip */ }
      }

      // Trader stopped: call exchange API directly (parallel across traders now)
      const trader = cfg.traders[traderId];
      const exchangeId = trader?.exchange ?? 'binance';
      const exchangeCfg = cfg.exchanges?.[exchangeId] ?? {};
      const apiKey = exchangeCfg.api_key ?? process.env[`${exchangeId.toUpperCase()}_API_KEY`] ?? '';
      const secretKey = exchangeCfg.secret_key ?? process.env[`${exchangeId.toUpperCase()}_SECRET_KEY`] ?? '';
      const tradingMode = trader?.trading_mode ?? 'futures';
      const useFutures = tradingMode === 'futures' || tradingMode === 'swap';

      if (!apiKey || !secretKey) {
        return [traderId, {
          error: 'No API key', totalEq: 0, balance: 0, available: 0,
          accountType: useFutures ? 'futures' : 'spot',
          exchange: exchangeId, trading_mode: tradingMode,
        }];
      }

      try {
        let bal: { totalEq?: string; availableBalance?: string; availBal?: string; walletBalance?: string; crossUnPnl?: string } | null = null;
        if (exchangeId.includes('binance')) {
          bal = await binanceGetBalance('USDT', useFutures);
        } else if (exchangeId.includes('okx')) {
          bal = await okxGetBalance('USDT');
        }

        if (bal) {
          return [traderId, {
            totalEq: parseFloat(bal.totalEq ?? '0'),
            equity: parseFloat(bal.totalEq ?? '0'),
            balance: parseFloat(bal.availableBalance ?? bal.availBal ?? '0'),
            available: parseFloat(bal.availableBalance ?? bal.availBal ?? '0'),
            walletBalance: parseFloat(bal.walletBalance ?? '0'),
            unrealizedPnl: parseFloat(bal.crossUnPnl ?? '0'),
            accountType: useFutures ? 'futures' : 'spot',
            exchange: exchangeId,
            trading_mode: tradingMode,
          }];
        }
        return [traderId, {
          error: 'Exchange API error', totalEq: 0, balance: 0, available: 0,
          accountType: useFutures ? 'futures' : 'spot',
          exchange: exchangeId, trading_mode: tradingMode,
        }];
      } catch (e) {
        return [traderId, {
          error: String(e), totalEq: 0, balance: 0, available: 0,
          accountType: useFutures ? 'futures' : 'spot',
          exchange: exchangeId, trading_mode: tradingMode,
        }];
      }
    }),
  );

  const balances: Record<string, Record<string, unknown>> = {};
  for (const [id, data] of results) {
    balances[id] = data;
  }
  res.json(balances);
});

// Market data proxy
app.get("/api/market", async (req: Request, res: Response) => {
  const symRaw = req.query.symbols;
  const symbols: string[] = (() => {
    if (symRaw === undefined || symRaw === "") {
      return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "BNBUSDT", "XRPUSDT"];
    }
    const list = typeof symRaw === "string" ? symRaw : Array.isArray(symRaw) ? (symRaw[0] as string) : "BTCUSDT";
    return list.split(",").map((s: string) => s.trim()).filter(Boolean);
  })();
  try {
    const data = await getMarketSummary(symbols);

    const SYMBOL_MAP: Record<string, string> = {
      BTCUSDT: "BTC", ETHUSDT: "ETH", SOLUSDT: "SOL",
      DOGEUSDT: "DOGE", BNBUSDT: "BNB", XRPUSDT: "OKB",
    };
    const out: Record<string, unknown> = {};
    for (const [inst, v] of Object.entries(data)) {
      const label = SYMBOL_MAP[inst] ?? inst;
      const entry = v as Record<string, unknown>;
      out[label] = {
        price: entry.ticker ? (entry.ticker as Record<string, string>).last : undefined,
        change24h: entry.ticker ? (entry.ticker as Record<string, string>).changePct24h : undefined,
        quoteVolume24h: entry.ticker ? (entry.ticker as Record<string, string>).quoteVol24h : undefined,
        fundingRate: entry.fundingRate,
        nextFundingTime: entry.nextFundingTime,
        openInterest: entry.openInterest,
        rsi_1h: entry.rsi_1h,
        rsi_6_1h: entry.rsi_6_1h,
        rsi_4h: entry.rsi_4h,
        rsi_6_4h: entry.rsi_6_4h,
        candles_1h: entry.candles_1h,
        candles_4h: entry.candles_4h,
      };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Single-symbol price proxy（替代前端直接调 OKX，解除 CORS + TLS 开销）──
app.get("/api/price", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? "BTCUSDT");
  try {
    const data = await getMarketSummary([symbol]);
    const entry = data[symbol] as Record<string, unknown> | undefined;
    const last = entry?.ticker ? (entry.ticker as Record<string, string>).last : "0";
    res.json({ price: parseFloat(last) || 0 });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Crypto News via RSS (2min TTL cache) ───────────────────────
const NEWS_SOURCES = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
  { url: "https://news.bitcoin.com/feed/", source: "Bitcoin.com" },
  { url: "https://www.theblock.co/rss.xml", source: "The Block" },
];

interface NewsItem { title: string; url: string; source: string; publishedAt?: string; }

function parseRssItems(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemMatches = Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/gi));
  for (const match of itemMatches) {
    const itemXml = match[1];
    const titleMatch = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(itemXml);
    const linkMatch = /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(itemXml);
    const pubMatch = /<pubDate[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i.exec(itemXml);
    const title = titleMatch?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
    const url = linkMatch?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
    if (title && url) {
      items.push({ title, url, source, publishedAt: pubMatch?.[1]?.trim() });
    }
    if (items.length >= 8) break;
  }
  return items;
}

app.get("/api/news", async (_req: Request, res: Response) => {
  // ── 2min TTL cache ──────────────────────────────────────────
  if (_newsCache && Date.now() - _newsCache.ts < NEWS_TTL_MS) {
    res.json(_newsCache.data);
    return;
  }

  const allItems: NewsItem[] = [];
  await Promise.allSettled(
    NEWS_SOURCES.map(async ({ url, source }) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const resp = await undiciFetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 AITradingKit/1.0" },
        });
        clearTimeout(timeout);
        if (!resp.ok) return;
        const xml = await resp.text();
        const items = parseRssItems(xml, source);
        allItems.push(...items);
      } catch {
        // single source failure — skip
      }
    }),
  );

  const seen = new Set<string>();
  const unique = allItems.filter((n) => {
    const key = n.title.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const result = { news: unique.slice(0, 30) };
  _newsCache = { ts: Date.now(), data: result };
  res.json(result);
});

// ── Session data files (async read + mtime cache) ───────────────
app.get("/data/:trader_id/:filename", async (req: Request, res: Response) => {
  const trader_id = String(req.params.trader_id);
  const filename = String(req.params.filename);
  if (!["status.json", "thinking.json", "trades.json"].includes(filename)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const filePath = join(SESSIONS_DIR, trader_id, filename);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: "not found" });
    return;
  }

  // Check in-memory trader status cache first (IPC-sourced, freshest)
  const cached = _traderStatusCache[trader_id] as Record<string, unknown> | undefined;
  if (cached) {
    const key = filename.replace(".json", "");
    if (cached[key] !== undefined) {
      res.json(cached[key]);
      return;
    }
  }

  // Fall back to async cached file read
  const data = await readCachedJson(filePath);
  if (data === null) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(data);
});

// AI test endpoint
app.post("/api/ai/test", async (req: Request, res: Response) => {
  const { marketData, positions, account, skillContent } = req.body;
  try {
    const { AIEngine } = await import("./ai_engine.js");
    const engine = new AIEngine();
    const decision = await engine.analyzeMarket({
      skillContent: skillContent ?? "默认策略",
      marketData: marketData ?? {},
      positions: positions ?? [],
      account: account ?? { totalEq: "1000" },
      tradeHistory: [],
      fallbackSymbol: "BTCUSDT",
    });
    res.json(decision);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Catch-all → serve index.html
app.get("*", (_req: Request, res: Response) => {
  const indexPath = join(PUBLIC_DIR, "index.html");
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send(`<html><body><h1>Binance Trading Bot TS</h1><p>v1.3.0 running on port ${SERVER_PORT}</p></body></html>`);
  }
});

// ── Error Handler ──────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[Server] Unhandled: ${err.message}`);
  res.status(500).json({ error: err.message });
});

// ── Graceful Shutdown ───────────────────────────────────────────

process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM — shutting down traders...");
  for (const [id] of Object.entries(TRADERS)) {
    stopTraderProcess(id);
  }
  process.exit(0);
});

// ── Start (HTTP + WebSocket on same port) ──────────────────────

const server = app.listen(SERVER_PORT, "0.0.0.0", () => {
  console.log(`[Server] Binance Trading Bot TS v1.3.0`);
  console.log(`[Server] Listening on http://0.0.0.0:${SERVER_PORT}`);
  console.log(`[Server] WebSocket on ws://0.0.0.0:${SERVER_PORT}`);
  console.log(`[Server] Data dir: ${DATA_DIR}`);
  console.log(`[Server] Sessions dir: ${SESSIONS_DIR}`);
});

// Attach WebSocket to the HTTP server (shares the same port)
const wssWithServer = new WebSocketServer({ server });
wssWithServer.on("connection", (ws: WebSocket) => {
  _wsClients.add(ws);
  ws.on("close", () => { _wsClients.delete(ws); });
  ws.on("error", (err) => { console.warn("[WS] Client error:", err.message); _wsClients.delete(ws); });
});
