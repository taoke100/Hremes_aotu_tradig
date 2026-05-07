"""
Binance 现货/期货 双模 Client — OpenClaw Trading Bot.
现货BASE_URL=https://api.binance.com  期货BASE_URL=https://fapi.binance.com
函数签名与 okx_client.py 完全对齐，方便 ai_trader.py 直接替换交易所。
td_mode=cash/spot → 现货下单; td_mode=cross/isolated → 期货下单
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import logging
import os
import time
from urllib.parse import urlencode
from typing import Any

import requests

logger = logging.getLogger(__name__)

# 现货: api.binance.com  |  期货: fapi.binance.com
BASE_URL = "https://api.binance.com"
FUTURES_URL = "https://fapi.binance.com"

# ──────────────── Auth ────────────────

def _sign(params: dict) -> str:
    secret = os.environ.get("BINANCE_SECRET_KEY", "")
    # Binance 要求用 urlencode 才能正确签名
    query = urlencode(sorted(params.items()))
    return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()


def _headers() -> dict:
    return {"Content-Type": "application/json", "X-MBX-APIKEY": os.environ.get("BINANCE_API_KEY", "")}


def _get(path: str, params: dict | None = None, auth: bool = False, use_futures: bool = False) -> dict | list | None:
    url = (FUTURES_URL if use_futures else BASE_URL) + path
    h = _headers() if auth else {}
    if auth:
        # Binance 签名必须包含 timestamp 和 recvWindow
        p = dict(params) if params else {}
        p["timestamp"] = int(time.time() * 1000)
        p["recvWindow"] = 5000
        p["signature"] = _sign(p)
        # 用完整 URL（不再传 params dict 给 requests，避免二次编码导致签名失效）
        url += "?" + urlencode(sorted(p.items()))
        try:
            r = requests.get(url, headers=h, timeout=10)
            return r.json()
        except Exception as e:
            logger.error(f"GET {url} error: {e}")
            return None
    if params:
        url += "?" + urlencode(params)
    try:
        r = requests.get(url, headers=h, timeout=10)
        return r.json()
    except Exception as e:
        logger.error(f"GET {url} error: {e}")
        return None


def _post(path: str, params: dict, auth: bool = True, use_futures: bool = False) -> dict | list | None:
    url = (FUTURES_URL if use_futures else BASE_URL) + path
    h = _headers()
    if auth:
        p = dict(params)
        p["timestamp"] = int(time.time() * 1000)
        p["recvWindow"] = 5000
        p["signature"] = _sign(p)
        url += "?" + urlencode(sorted(p.items()))
        try:
            r = requests.post(url, headers=h, timeout=10)
            return r.json()
        except Exception as e:
            logger.error(f"POST {url} error: {e}")
            return None
    try:
        r = requests.post(url, headers=h, json=params, timeout=10)
        return r.json()
    except Exception as e:
        logger.error(f"POST {url} error: {e}")
        return None


def _get_auth(path: str, params: dict | None = None, use_futures: bool = False) -> dict | list | None:
    """Binance authenticated GET (signature required for /fapi/* and /api/* endpoints)."""
    url = (FUTURES_URL if use_futures else BASE_URL) + path
    p = dict(params) if params else {}
    p["timestamp"] = int(time.time() * 1000)
    p["recvWindow"] = 5000
    p["signature"] = _sign(p)
    url += "?" + urlencode(sorted(p.items()))
    try:
        r = requests.get(url, headers=_headers(), timeout=10)
        return r.json()
    except Exception as e:
        logger.error(f"GET {url} error: {e}")
        return None


def _normalize(symbol: str) -> str:
    """Convert common formats to Binance symbol: BTC-USDT-SWAP → BTCUSDT."""
    s = symbol.upper().strip()
    for sep in ("-USDT-SWAP", "-USDT", "-SWAP", "/USDT"):
        if s.endswith(sep):
            s = s[: -len(sep)]
            break
    if not s.endswith("USDT"):
        s = s + "USDT"
    return s


# ══════════════════════════════════════════════════════════════
#  Market Data (public)
# ══════════════════════════════════════════════════════════════

def get_ticker(inst_id: str) -> dict | None:
    """Get 24h ticker. inst_id: 'BTCUSDT' or 'BTC-USDT-SWAP'."""
    sym = _normalize(inst_id)
    # 优先用现货公开接口
    data = _get("/api/v3/ticker/24hr", {"symbol": sym}, use_futures=False)
    if not isinstance(data, dict) or "symbol" not in data:
        # 备用期货接口
        data = _get("/fapi/v1/ticker/24hr", {"symbol": sym}, use_futures=True)
        if not isinstance(data, dict) or "symbol" not in data:
            return None
    return data


def get_candles(inst_id: str, bar: str = "1h", limit: int = 20) -> list:
    """K-line数据. bar: 1m/5m/15m/30m/1h/2h/4h/6h/12h/1d."""
    sym = _normalize(inst_id)
    interval_map = {"1h": "1h", "4h": "4h", "1d": "1d", "5m": "5m", "15m": "15m", "30m": "30m", "2h": "2h", "6h": "6h", "12h": "12h"}
    interval = interval_map.get(bar, bar)
    # 现货 klines
    data = _get("/api/v3/klines", {"symbol": sym, "interval": interval, "limit": limit}, use_futures=False)
    if not isinstance(data, list):
        # 备用期货 klines
        data = _get("/fapi/v1/klines", {"symbol": sym, "interval": interval, "limit": limit}, use_futures=True)
        if not isinstance(data, list):
            return []
    # Binance: [openTime, o, h, l, c, vol, closeTime, ...]
    out = []
    for c in data:
        if isinstance(c, list) and len(c) >= 6:
            out.append([
                datetime.datetime.fromtimestamp(c[0] / 1000).strftime("%Y-%m-%d %H:%M:%S"),
                c[1], c[2], c[3], c[4], c[5],
            ])
    return out


def get_funding_rate(inst_id: str) -> dict | None:
    sym = _normalize(inst_id)
    data = _get("/fapi/v1/premiumIndex", {"symbol": sym})
    return data


def get_open_interest(inst_id: str) -> dict | None:
    sym = _normalize(inst_id)
    return _get("/fapi/v1/openInterest", {"symbol": sym})


def get_all_swap_tickers(quote_ccy: str = "USDT") -> list:
    """所有 USDT 交易对 ticker（公开接口）."""
    # 现货所有 USDT 交易对
    data = _get("/api/v3/ticker/24hr", use_futures=False)
    if not isinstance(data, list):
        # 备用期货
        data = _get("/fapi/v1/ticker/24hr", use_futures=True)
        if not isinstance(data, list):
            return []
    return [t for t in data if t.get("symbol", "").endswith("USDT")]


def get_top_gainers(
    min_vol_usdt: float = 20_000_000,
    min_gain_pct: float = 10.0,
    max_gain_pct: float = 200.0,
    top_n: int = 10,
) -> list:
    """返回 Binance symbol 列表，如 ['ORDIUSDT', '1000SATSUSDT']."""
    tickers = get_all_swap_tickers()
    if not tickers:
        return []
    _EXCLUDE = {"BTCUSDT", "ETHUSDT", "BNBUSDT", "USDCUSDT", "BUSDUSDT", "DAIUSDT", "FDUSDUSDT"}
    candidates = []
    for t in tickers:
        sym = t.get("symbol", "")
        if sym in _EXCLUDE:
            continue
        try:
            last = float(t.get("lastPrice", 0) or 0)
            open_px = float(t.get("openPrice", 0) or 0)
            vol = float(t.get("quoteVolume", 0) or 0)
        except (ValueError, TypeError):
            continue
        if last <= 0 or open_px <= 0 or vol < min_vol_usdt:
            continue
        gain = (last - open_px) / open_px * 100.0
        if not (min_gain_pct <= gain <= max_gain_pct):
            continue
        candidates.append((gain, vol, sym))
    candidates.sort(key=lambda x: (-x[0], -x[1]))
    result = [c[2] for c in candidates[:top_n]]
    logger.info(f"Top gainers ({len(result)}): " + ", ".join(f"{c[2]}(+{c[0]:.1f}%)" for c in candidates[:top_n]))
    return result


# ──────────────── Account / Positions (signed) ────────────────

def get_balance(ccy: str = "USDT", use_futures: bool = False) -> dict | None:
    """获取账户余额. use_futures=True 强制查合约，否则查现货."""
    if use_futures:
        data = _get_auth("/fapi/v2/balance", {}, use_futures=True)
        if isinstance(data, list):
            for b in data:
                if b.get("asset") == ccy:
                    wallet = b.get("balance", "0")
                    cross_pnl = b.get("crossUnPnl", "0")
                    return {
                        "totalEq":       str(float(wallet) + float(cross_pnl)),  # 净值 = 钱包 + 未实现盈亏
                        "availBal":      b.get("availableBalance", "0"),           # 可用余额（别名兼容ai_trader）
                        "walletBalance": wallet,                                  # 钱包余额
                        "crossUnPnl":    cross_pnl,
                        "marginBalance": str(float(wallet) + float(cross_pnl)),   # 保证金余额 = 净值
                        "details": [b],
                    }
        return None

    # 现货账户
    data = _get("/api/v3/account", {}, auth=True, use_futures=False)
    if isinstance(data, dict) and "balances" in data:
        for b in data.get("balances", []):
            if b.get("asset") == ccy:
                return {
                    "totalEq": b.get("free", "0"),
                    "availBal": b.get("free", "0"),
                    "locked": b.get("locked", "0"),
                    "details": [b],
                }
        return None
    return None


def get_positions(inst_type: str = "SWAP") -> list:
    """获取所有持仓. 现货返回 [], 期货返回实际持仓."""
    if inst_type != "SWAP":
        return []
    data = _get_auth("/fapi/v2/positionRisk", {"marginAsset": "USDT"}, use_futures=True)
    if not isinstance(data, list):
        return []
    out = []
    for p in data:
        amt = float(p.get("positionAmt", 0) or 0)
        if amt == 0:
            continue
        out.append({
            "instId": p.get("symbol", ""),
            "pos": str(amt),
            "posSide": "long" if amt > 0 else "short",
            "avgPx": p.get("entryPrice", "0"),
            "upl": p.get("unrealizedProfit", "0"),
            "lever": p.get("leverage", "1"),
            "margin": p.get("isolatedMargin", p.get("margin", "0")),
            "markPx": p.get("markPrice", "0"),
        })
    return out


def set_leverage(inst_id: str, lever: int, margin_mode: str = "cross") -> dict | None:
    sym = _normalize(inst_id)
    mgn = "crossedMargin" if margin_mode == "cross" else "isolatedMargin"
    return _post("/fapi/v1/leverage", {"symbol": sym, "leverage": lever, "marginType": mgn}, auth=True, use_futures=True)


# ──────────────── Trading ────────────────

def place_order(
    inst_id: str,
    side: str,
    ord_type: str,
    sz: str,
    px: str | None = None,
    td_mode: str = "cross",
    pos_side: str | None = None,
    sl_trigger_px: str | None = None,
    sl_ord_px: str | None = None,
    tp_trigger_px: str | None = None,
    tp_ord_px: str | None = None,
) -> dict | None:
    """下单. 现货优先(td_mode=cash), 期货用 td_mode=cross/isolated."""
    sym = _normalize(inst_id)
    is_spot = td_mode.lower() in ("cash", "spot")

    if is_spot:
        # 现货下单
        params: dict[str, Any] = {
            "symbol": sym,
            "side": side.upper(),
            "type": ord_type.upper() if ord_type.upper() in ("LIMIT", "MARKET") else "LIMIT",
            "quantity": sz,
        }
        if px:
            params["price"] = px
            params["timeInForce"] = "GTC"
        return _post("/api/v3/order", params, auth=True, use_futures=False)
    else:
        # 期货下单
        params = {
            "symbol": sym,
            "side": side.upper(),
            "type": ord_type.upper(),
            "quantity": sz,
        }
        if px:
            params["price"] = px
            params["timeInForce"] = "GTC"
        if pos_side:
            params["positionSide"] = pos_side.upper()
        if sl_trigger_px or tp_trigger_px:
            if sl_trigger_px:
                params["stopPrice"] = sl_trigger_px
                params["type"] = "STOP"
            if tp_trigger_px:
                params["stopPrice"] = tp_trigger_px
                params["type"] = "TAKE_PROFIT"
        return _post("/fapi/v1/order", params, auth=True, use_futures=True)


def place_algo_order(
    inst_id: str,
    side: str,
    sz: str,
    tp_trigger_px: str | None = None,
    sl_trigger_px: str | None = None,
    td_mode: str = "cross",
) -> dict | None:
    """Binance 条件单/止盈止损 (期货)."""
    sym = _normalize(inst_id)
    is_spot = td_mode.lower() in ("cash", "spot")
    if is_spot:
        # 现货止盈止损 - 使用 OCO 订单
        params: dict[str, Any] = {
            "symbol": sym,
            "side": side.upper(),
            "quantity": sz,
        }
        if sl_trigger_px:
            params["stopLossPrice"] = sl_trigger_px
            params["stopLossTimeInForce"] = "GTC"
        if tp_trigger_px:
            params["takeProfitPrice"] = tp_trigger_px
        return _post("/api/v3/order/oco", params, auth=True, use_futures=False)
    else:
        params: dict[str, Any] = {
            "symbol": sym,
            "side": side.upper(),
            "type": "STOP",
            "quantity": sz,
            "timeInForce": "GTC",
        }
        if sl_trigger_px:
            params["stopPrice"] = sl_trigger_px
            params["type"] = "STOP"
        if tp_trigger_px:
            params["stopPrice"] = tp_trigger_px
            params["type"] = "TAKE_PROFIT"
        return _post("/fapi/v1/order", params, auth=True, use_futures=True)


def close_position(inst_id: str, margin_mode: str = "cross") -> dict | None:
    """全平仓位."""
    sym = _normalize(inst_id)
    positions = get_positions("SWAP")
    for p in positions:
        if p.get("instId") == sym:
            amt = float(p.get("pos", 0))
            if amt == 0:
                continue
            close_side = "SELL" if amt > 0 else "BUY"
            return place_order(sym, close_side, "MARKET", str(abs(amt)), reduce_only=True)
    return None


# ──────────────── Technical Indicators ────────────────

def compute_rsi(candles: list, period: int = 14) -> float | None:
    """从 K 线计算 RSI."""
    if len(candles) < period + 1:
        return None
    closes = [float(c[4]) for c in candles if isinstance(c, list) and len(c) >= 5]
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(0, d))
        losses.append(max(0, -d))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


# ──────────────── 期货数据（资金费率 & 持仓量）────────────———


def get_funding_rate(symbol: str) -> dict | None:
    """获取 Binance 期货资金费率. symbol 如 'BTCUSDT'."""
    sym = _normalize(symbol)
    data = _get("/fapi/v1/premiumIndex", {"symbol": sym}, use_futures=True)
    if not data or "lastFundingRate" not in data:
        return None
    return {
        "symbol":        data.get("symbol", sym),
        "fundingRate":  float(data.get("lastFundingRate", 0)),   # 如 -0.00001927
        "nextFundingTime": data.get("nextFundingTime"),          # ms 时间戳
        "markPrice":    float(data.get("markPrice", 0)),
        "indexPrice":   float(data.get("indexPrice", 0)),
    }


def get_open_interest(symbol: str) -> dict | None:
    """获取 Binance 期货持仓量(Open Interest). symbol 如 'BTCUSDT'."""
    sym = _normalize(symbol)
    data = _get("/fapi/v1/openInterest", {"symbol": sym}, use_futures=True)
    if not data or "openInterest" not in data:
        return None
    return {
        "symbol":       data.get("symbol", sym),
        "openInterest": float(data.get("openInterest", 0)),      # 名义价值(USD)
        "time":         data.get("time"),
    }


# ──────────────── Helpers ────────────────

def normalize_inst_id(symbol: str) -> str:
    return _normalize(symbol)


def get_market_summary(instruments: list[str]) -> dict[str, Any]:
    """获取多个币种的完整市场数据."""
    result = {}
    for inst in instruments:
        sym = _normalize(inst)
        entry: dict[str, Any] = {}
        # Ticker
        t = get_ticker(sym)
        if t:
            entry["ticker"] = {
                "last": t.get("lastPrice", "0"),
                "high24h": t.get("highPrice", "0"),
                "low24h": t.get("lowPrice", "0"),
                "vol24h": t.get("volume", "0"),
                "quoteVol24h": t.get("quoteVolume", "0"),
                "change24h": t.get("priceChange", "0"),
                "changePct24h": t.get("priceChangePercent", "0"),
                "bidPx": t.get("bidPrice", "0"),
                "askPx": t.get("askPrice", "0"),
                "openPrice": t.get("openPrice", "0"),
            }
        # K 线 + RSI（RSI6 用于威科夫策略，RSI14 用于通用）
        c1h = get_candles(sym, "1h", 30)
        if c1h:
            entry["candles_1h"] = c1h
            entry["rsi_1h"]  = compute_rsi(c1h, 14)
            entry["rsi_6_1h"] = compute_rsi(c1h, 6)   # 威科夫策略核心指标
        c4h = get_candles(sym, "4h", 30)
        if c4h:
            entry["candles_4h"] = c4h
            entry["rsi_4h"]  = compute_rsi(c4h, 14)
            entry["rsi_6_4h"] = compute_rsi(c4h, 6)
        # 期货资金费率
        fr = get_funding_rate(sym)
        if fr:
            entry["fundingRate"] = fr["fundingRate"]
            entry["nextFundingTime"] = fr.get("nextFundingTime")
        # 持仓量
        oi = get_open_interest(sym)
        if oi:
            entry["openInterest"] = oi["openInterest"]
        result[inst] = entry
    return result
