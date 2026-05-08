/**
 * Server — Express API + Static File Server (TypeScript)
 * Manages trader subprocesses, exposes REST API for the frontend.
 */
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import { fetch } from "undici";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, ChildProcess } from "node:child_process";
import type { TraderStatus, HealthStatus, TraderInfo } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");
const PUBLIC_DIR = join(BASE_DIR, "public");
const DATA_DIR = join(BASE_DIR, "data");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const SYSTEM_CONFIG_FILE = join(DATA_DIR, "system_config.json");
const SERVER_PORT = parseInt(process.env.PORT ?? "8888");

const TRADERS: Record<string, ChildProcess> = {};
const SERVER_START = Date.now();

// Load env
try {
  const envPath = join(process.env.HOME ?? "", ".hermes", ".env");
  if (existsSync(envPath)) {
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
    console.log("[Server] Loaded .env credentials");
  }
} catch {
  console.warn("[Server] .env not found, using existing env vars");
}

// ── Express Setup ────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Serve public static files
app.use(express.static(PUBLIC_DIR));

// ── Multer (multipart/form-data for trader creation) ──────────
const upload = multer({ storage: multer.memoryStorage() });

// ── Config Helpers ───────────────────────────────────────────

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
}
interface SystemConfig {
  traders: Record<string, TraderConfig>;
  ai_providers: Record<string, { type: string; api_key: string; base_url: string; model: string }>;
  exchanges: Record<string, Record<string, string>>;
  web_brand?: string;
  web_title?: string;
}

function loadSystemConfig(): SystemConfig {
  if (existsSync(SYSTEM_CONFIG_FILE)) {
    return JSON.parse(readFileSync(SYSTEM_CONFIG_FILE, "utf-8"));
  }
  return { traders: {}, ai_providers: {}, exchanges: {} };
}

/** Deep-merge partial updates into existing system config. */
function saveSystemConfig(updates: Partial<SystemConfig>): void {
  const current = loadSystemConfig();
  const merged: SystemConfig = {
    traders: { ...current.traders, ...(updates.traders || {}) },
    ai_providers: { ...current.ai_providers, ...(updates.ai_providers || {}) },
    exchanges: { ...current.exchanges, ...(updates.exchanges || {}) },
    ...(updates.web_brand !== undefined ? { web_brand: updates.web_brand } : {}),
    ...(updates.web_title !== undefined ? { web_title: updates.web_title } : {}),
  };
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SYSTEM_CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
}

// ── Trader Process Management ────────────────────────────────

function getTraderEnv() {
  const env = { ...process.env };
  // Filter to only necessary keys to avoid leaking
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

  // Try bun first, then node + tsx
  const useBun = existsSync(bunPath);
  const useNvm = existsSync(nodePath);

  const execPath = useBun ? bunPath : useNvm ? nodePath : process.execPath;
  const scriptArgs = useBun
    ? [join(__dirname, "trader.ts"), traderId]
    : ["--import", "tsx", join(__dirname, "trader.ts"), traderId];

  const child = spawn(execPath, scriptArgs, {
    stdio: ["ignore", "pipe", "pipe"],
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
    ...traderCfg, // name, ai_provider, exchange, scan_frequency, initial_balance, etc.
    pid: child?.pid ?? 0,
    status: child && !child.killed ? "running" : "stopped",
  };
}

// ── API Routes ──────────────────────────────────────────────

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

// Create trader (multipart/form-data: id, name, ai_provider, exchange, scan_frequency, initial_balance, skill_file)
app.post("/api/traders", upload.single("skill_file"), (req: Request, res: Response) => {
  const id = req.body.id as string;
  if (!id || typeof id !== "string" || id.trim() === "") {
    res.status(400).json({ error: "id is required" });
    return;
  }
  const cfg = loadSystemConfig();
  if (cfg.traders[id]) {
    res.status(409).json({ error: `Trader '${id}' already exists` });
    return;
  }
  const skillContent = req.file
    ? req.file.buffer.toString("utf-8")
    : (req.body.skill_content as string | undefined) ?? "";

  cfg.traders[id] = {
    name: (req.body.name as string) ?? id,
    exchange: (req.body.exchange as string) ?? "binance",
    ai_provider: (req.body.ai_provider as string) ?? "",
    scan_frequency: parseInt(req.body.scan_frequency as string) || 30,
    initial_balance: req.body.initial_balance
      ? parseFloat(req.body.initial_balance as string)
      : undefined,
    skill_content: skillContent,
    skill_filename: req.file?.originalname ?? "",
    status: "stopped",
  };
  saveSystemConfig(cfg);
  res.json({ status: "created", id, ...getTraderInfo(id) });
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
    // Direct write — do NOT use saveSystemConfig() which re-merges with on-disk state
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SYSTEM_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
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

// Balance proxy (reads from status.json)
app.get("/api/balance", (_req: Request, res: Response) => {
  const cfg = loadSystemConfig();
  const balances: Record<string, Record<string, number>> = {};
  for (const traderId of Object.keys(cfg.traders)) {
    const statusPath = join(SESSIONS_DIR, traderId, "status.json");
    if (existsSync(statusPath)) {
      try {
        const s = JSON.parse(readFileSync(statusPath, "utf-8")) as TraderStatus;
        balances[traderId] = {
          equity: s.equity,
          balance: s.balance,
          total_profit: s.total_profit,
          yield_rate: s.yield_rate,
          unrealized_pnl: s.unrealized_pnl,
          available: s.available,
          positions: s.positions,
        };
      } catch { /* skip */ }
    }
  }
  res.json(balances);
});

// Market data proxy
app.get("/api/market", async (req: Request, res: Response) => {
  const symRaw = req.query.symbols;
  // Default to the 4 symbols shown on the frontend market cards
  const symbols: string[] = (() => {
    if (symRaw === undefined || symRaw === "") {
      return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "BNBUSDT", "XRPUSDT"];
    }
    const list = typeof symRaw === "string" ? symRaw : Array.isArray(symRaw) ? (symRaw[0] as string) : "BTCUSDT";
    return list.split(",").map((s: string) => s.trim()).filter(Boolean);
  })();
  try {
    const { getMarketSummary } = await import("./binance.js");
    const data = await getMarketSummary(symbols);

    // ── Frontend compatibility: flatten nested ticker and remap keys ──
    // Frontend expects: marketData['BTC'] = { price, change24h, quoteVolume24h, fundingRate, ... }
    // Binance returns:  data['BTCUSDT'] = { ticker: { last, changePct24h, quoteVol24h, ... }, fundingRate, ... }
    const SYMBOL_MAP: Record<string, string> = {
      BTCUSDT: "BTC",
      ETHUSDT: "ETH",
      SOLUSDT: "SOL",
      DOGEUSDT: "DOGE",
      BNBUSDT: "BNB",
      XRPUSDT: "OKB",
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

// ── Crypto News via RSS aggregation ─────────────────────────────────────────
const NEWS_SOURCES = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
  { url: "https://news.bitcoin.com/feed/", source: "Bitcoin.com" },
  { url: "https://www.theblock.co/rss.xml", source: "The Block" },
];

interface NewsItem { title: string; url: string; source: string; publishedAt?: string; }

// Minimal regex-based RSS item parser (no external XML deps needed)
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
    if (items.length >= 8) break; // max 8 items per source
  }
  return items;
}

app.get("/api/news", async (_req: Request, res: Response) => {
  try {
    const allItems: NewsItem[] = [];
    await Promise.allSettled(
      NEWS_SOURCES.map(async ({ url, source }) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          const resp = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 HermesTradingBot/1.0" },
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
    // Deduplicate by title (some stories appear in multiple feeds)
    const seen = new Set<string>();
    const unique = allItems.filter((n) => {
      const key = n.title.slice(0, 60).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Newest first (roughly — RSS doesn't always have sortable dates)
    res.json({ news: unique.slice(0, 30) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Session data files
app.get("/data/:trader_id/:filename", (req: Request, res: Response) => {
  const trader_id = String(req.params.trader_id);
  const filename = String(req.params.filename);
  if (!["status.json", "thinking.json", "trades.json"].includes(filename)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const filePath = join(SESSIONS_DIR, String(trader_id), filename);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(JSON.parse(readFileSync(filePath, "utf-8")));
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

// News endpoint (stub)
app.get("/api/news", (_req: Request, res: Response) => {
  res.json([]);
});

// Catch-all → serve index.html
app.get("*", (_req: Request, res: Response) => {
  const indexPath = join(PUBLIC_DIR, "index.html");
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send(`<html><body><h1>Binance Trading Bot TS</h1><p>v1.2.0 running on port ${SERVER_PORT}</p></body></html>`);
  }
});

// ── Error Handler ───────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[Server] Unhandled: ${err.message}`);
  res.status(500).json({ error: err.message });
});

// ── Graceful Shutdown ────────────────────────────────────────

process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM — shutting down traders...");
  for (const [id] of Object.entries(TRADERS)) {
    stopTraderProcess(id);
  }
  process.exit(0);
});

// ── Start ───────────────────────────────────────────────────

app.listen(SERVER_PORT, "0.0.0.0", () => {
  console.log(`[Server] Binance Trading Bot TS v1.2.0`);
  console.log(`[Server] Listening on http://0.0.0.0:${SERVER_PORT}`);
  console.log(`[Server] Data dir: ${DATA_DIR}`);
  console.log(`[Server] Sessions dir: ${SESSIONS_DIR}`);
});
