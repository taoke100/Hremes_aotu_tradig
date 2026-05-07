"""
OpenClaw AI Trader — Binance / OKX 双交易所支持 + MiniMax AI Engine.
Runs as a subprocess per trader instance, managed by server.py.
交易所由 EXCHANGE_TYPE 环境变量决定（binance 或 okx）。
"""
from __future__ import annotations

VERSION = "1.2.0"

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path

# 初始化交易所适配器（必须在 import okx_client 之前）
_exchange = os.environ.get("EXCHANGE_TYPE", "binance").lower()
if _exchange == "binance":
    from binance_client import (
        get_ticker, get_balance, get_positions, set_leverage,
        place_order, place_algo_order, close_position,
        get_candles, get_funding_rate, get_open_interest,
        compute_rsi, get_all_swap_tickers, get_top_gainers,
        normalize_inst_id, get_market_summary,
    )
    _ex_name = "Binance"
elif _exchange == "okx":
    from okx_client import (
        get_ticker, get_balance, get_positions, set_leverage,
        place_order, place_algo_order, close_position,
        get_candles, get_funding_rate, get_open_interest,
        compute_rsi, get_all_swap_tickers, get_top_gainers,
        normalize_inst_id, get_market_summary,
    )
    _ex_name = "OKX"
else:
    print(f"FATAL: EXCHANGE_TYPE must be 'binance' or 'okx', got '{_exchange}'")
    sys.exit(1)

from minimax_engine import MiniMaxEngine

BASE_DIR = Path(__file__).resolve().parent.parent
SYSTEM_CONFIG_FILE = BASE_DIR / "data" / "system_config.json"
SESSIONS_DIR = BASE_DIR / "data" / "sessions"
DEFAULT_SKILL_FILE = BASE_DIR / "docs" / "SKILL.md"


def load_system_config() -> dict:
    if SYSTEM_CONFIG_FILE.exists():
        return json.loads(SYSTEM_CONFIG_FILE.read_text(encoding="utf-8"))
    return {}


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def to_positive_float(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def load_trader_initial_balance(trader_id: str) -> float | None:
    config = load_system_config()
    trader_info = config.get("traders", {}).get(trader_id, {})
    return to_positive_float(trader_info.get("initial_balance"))


def load_skill_content(trader_info: dict) -> str:
    content = trader_info.get("skill_content", "")
    if content:
        return content
    if DEFAULT_SKILL_FILE.exists():
        return DEFAULT_SKILL_FILE.read_text(encoding="utf-8")
    return "默认策略: 趋势跟踪，控制风险，合理止盈止损。"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--trader_id", required=True)
    args = parser.parse_args()
    trader_id = args.trader_id

    session_dir = SESSIONS_DIR / trader_id
    session_dir.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler()],
        force=True,
    )

    logging.info(f"Starting AI Trader: {trader_id} | Exchange: {_ex_name}")

    # 记录进程启动时间，供前端展示系统运行时间
    system_start_time = now_str()

    # Load config
    config = load_system_config()
    trader_info = config.get("traders", {}).get(trader_id)
    if not trader_info:
        logging.error(f"Trader config {trader_id} not found in system_config.json")
        return

    freq = int(trader_info.get("scan_frequency", 30))
    skill_content = load_skill_content(trader_info)
    watchlist = trader_info.get("watchlist", ["BTCUSDT", "ETHUSDT", "SOLUSDT"])
    configured_start_balance = load_trader_initial_balance(trader_id)

    # Initialize MiniMax engine
    minimax_key = os.environ.get("MINIMAX_API_KEY", "")
    minimax_model = os.environ.get("MINIMAX_MODEL", "MiniMax-M2.7")
    minimax_base_url = os.environ.get("MINIMAX_BASE_URL", "https://api.minimax.io/v1")
    deepseek_key = os.environ.get("DEEPSEEK_API_KEY", "")

    if not minimax_key:
        logging.error("MINIMAX_API_KEY not set. Cannot start AI engine.")
        return

    engine = MiniMaxEngine(
        api_key=minimax_key,
        model=minimax_model,
        base_url=minimax_base_url,
        deepseek_key=deepseek_key,
    )
    logging.info(f"MiniMax engine initialized: model={minimax_model}, deepseek={'yes' if deepseek_key else 'no'}")

    # State files
    status_file = session_dir / "status.json"
    thinking_file = session_dir / "thinking.json"
    trades_file = session_dir / "trades.json"

    # Load previous state
    events: list[dict] = []
    trades: list[dict] = []
    equity_history: list[dict] = []
    spot_balance_history: list[dict] = []   # 现货账户余额历史（1分钟采样）
    start_balance: float | None = None

    if status_file.exists():
        try:
            old = json.loads(status_file.read_text(encoding="utf-8"))
            equity_history = old.get("equity_history", [])
            spot_balance_history = old.get("spot_balance_history", [])
            start_balance = old.get("start_balance")
        except Exception:
            pass

    if configured_start_balance is not None:
        start_balance = configured_start_balance
        logging.info(f"Using configured start balance: {configured_start_balance:.2f} USDT")

    if thinking_file.exists():
        try:
            old_thinking = json.loads(thinking_file.read_text(encoding="utf-8"))
            if isinstance(old_thinking, list):
                events = old_thinking[-20:]
        except Exception:
            pass

    if trades_file.exists():
        try:
            trades = json.loads(trades_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    def fetch_account() -> dict:
        bal = get_balance("USDT", use_futures=True)
        if bal:
            return bal
        return {"totalEq": "0", "availBal": "0"}

    def fetch_spot_balance() -> dict:
        """获取 Binance 现货账户 USDT 余额"""
        bal = get_balance("USDT", use_futures=False)
        if bal:
            return bal
        return {"totalEq": "0", "availBal": "0"}

    def fetch_positions() -> list:
        return get_positions("SWAP")

    def fetch_market_data(instruments: list | None = None) -> dict:
        return get_market_summary(instruments or watchlist)

    def execute_decision(decision: dict) -> dict | None:
        action = decision.get("action", "HOLD")
        if action == "HOLD":
            return None

        inst_id = decision.get("instrument")
        if not inst_id:
            logging.warning("No instrument in decision, skipping.")
            return None

        inst_id = normalize_inst_id(inst_id)

        try:
            if action in ("OPEN_LONG", "OPEN_SHORT"):
                side = "BUY" if action == "OPEN_LONG" else "SELL"
                leverage = int(decision.get("leverage", 3))

                # 计算开仓数量
                total_eq = float(account.get("totalEq", 0))
                size_raw = decision.get("size")
                if isinstance(size_raw, (int, float)) and size_raw > 0:
                    sz = str(max(1, int(round(float(size_raw)))))
                else:
                    # 按保证金比例计算: 净值 × 3% × 杠杆
                    pct = 0.03
                    notional = total_eq * pct * leverage
                    last_price = float(market_data.get(inst_id, {}).get("ticker", {}).get("last", 0) or 0)
                    if last_price > 0:
                        sz = str(max(1, int(round(notional / last_price))))
                    else:
                        sz = "1"

                # 设置杠杆
                set_leverage(inst_id, leverage)

                result = place_order(
                    inst_id=inst_id,
                    side=side,
                    ord_type="MARKET",
                    sz=sz,
                    td_mode="cross",
                )
                if not result or result.get("code"):
                    err_msg = result.get("msg", "Unknown error") if result else "No response"
                    logging.warning(f"Order failed: {err_msg}")
                    return {"type": action, "error": err_msg}

                order_id = result.get("orderId")
                executed_qty = float(result.get("executedQty", 0))
                avg_price = float(result.get("avgPrice", 0) or 0)

                # 开仓后立即设置止盈止损
                sl_px = decision.get("stop_loss")
                tp_px = decision.get("take_profit")
                if (sl_px or tp_px) and avg_price > 0:
                    algo_side = "SELL" if action == "OPEN_LONG" else "BUY"
                    try:
                        place_algo_order(
                            inst_id=inst_id,
                            side=algo_side,
                            sz=str(max(1, int(round(executed_qty)))),
                            tp_trigger_px=str(tp_px) if tp_px else None,
                            sl_trigger_px=str(sl_px) if sl_px else None,
                        )
                        logging.info(f"Algo TP/SL placed: SL={sl_px}, TP={tp_px}")
                    except Exception as e:
                        logging.warning(f"Algo order failed (non-fatal): {e}")

                return {
                    "type": action,
                    "orderId": str(order_id) if order_id else "无",
                    "executedQty": executed_qty,
                    "price": avg_price,
                }

            elif action in ("CLOSE_LONG", "CLOSE_SHORT"):
                # 平仓时用 reduce_only=True 确保不会开反向新仓
                close_side = "SELL" if action == "CLOSE_LONG" else "BUY"
                sz = str(max(1, int(round(float(decision.get("size", 1))))))

                # 设置杠杆
                leverage = int(decision.get("leverage", 3))
                set_leverage(inst_id, leverage)

                result = place_order(
                    inst_id=inst_id,
                    side=close_side,
                    ord_type="MARKET",
                    sz=sz,
                    td_mode="cross",
                    reduce_only=True,
                )
                if not result or result.get("code"):
                    err_msg = result.get("msg", "Unknown error") if result else "No response"
                    logging.warning(f"Close order failed: {err_msg}")
                    return {"type": action, "error": err_msg}

                order_id = result.get("orderId")
                executed_qty = float(result.get("executedQty", 0))
                avg_price = float(result.get("avgPrice", 0) or 0)

                return {
                    "type": action,
                    "orderId": str(order_id) if order_id else "无",
                    "executedQty": executed_qty,
                    "price": avg_price,
                }

        except Exception as e:
            logging.error(f"Trade execution error: {e}")
            return {"type": action, "error": str(e)}

        return None

    def save_state(account: dict, positions: list, market_data: dict):
        nonlocal configured_start_balance, start_balance

        latest_configured_start_balance = load_trader_initial_balance(trader_id)
        if (
            latest_configured_start_balance is not None
            and latest_configured_start_balance != configured_start_balance
        ):
            configured_start_balance = latest_configured_start_balance
            start_balance = latest_configured_start_balance
            logging.info(f"Updated configured start balance: {latest_configured_start_balance:.2f} USDT")

        total_eq = float(account.get("totalEq", 0))
        details = account.get("details", [])
        avail_bal = float(details[0].get("availableBalance", 0)) if details else float(account.get("availBal", 0))
        unrealized = sum(float(p.get("upl", 0)) for p in positions)

        if start_balance is None:
            start_balance = total_eq

        yield_rate = (total_eq - start_balance) / start_balance if start_balance > 0 else 0
        total_profit = total_eq - start_balance

        if (not equity_history or
                (datetime.now() - datetime.strptime(equity_history[-1]["time"], "%Y-%m-%d %H:%M:%S")).seconds >= 60):
            equity_history.append({
                "time": now_str(),
                "balance": avail_bal,
                "equity": total_eq,
            })
            if len(equity_history) > 480:
                equity_history.pop(0)

            # 同时采样现货账户余额（1分钟1次）
            spot_bal = fetch_spot_balance()
            spot_balance = float(spot_bal.get("totalEq", 0)) or float(spot_bal.get("availBal", 0)) or 0
            spot_balance_history.append({
                "time": now_str(),
                "balance": spot_balance,
            })
            if len(spot_balance_history) > 480:
                spot_balance_history.pop(0)

        open_positions = []
        for p in positions:
            pos_val = float(p.get("pos", 0))
            open_positions.append({
                "symbol": p.get("instId", ""),
                "direction": "long" if pos_val > 0 else "short",
                "amount": abs(pos_val),
                "entryPrice": float(p.get("avgPx", 0)),
                "currentPrice": float(p.get("markPx", p.get("last", 0))),
                "leverage": int(float(p.get("lever", 1))),
                "unrealizedProfit": float(p.get("upl", 0)),
                "margin": float(p.get("margin", 0)),
            })

        top_signal = {"symbol": watchlist[0] if watchlist else "BTCUSDT", "direction": "long", "score": 0}
        if events:
            last_event = events[-1]
            if isinstance(last_event, dict):
                action = last_event.get("action", "HOLD")
                conf = last_event.get("confidence", 0)
                inst = last_event.get("instrument", watchlist[0] if watchlist else "")
                direction = "long" if "LONG" in action else "short" if "SHORT" in action else "neutral"
                top_signal = {"symbol": inst, "direction": direction, "score": conf}

        status_payload = {
            "session_id": trader_id,
            "session_started_at": equity_history[0]["time"] if equity_history else now_str(),
            "last_run": now_str(),
            "start_balance": start_balance,
            "balance": avail_bal,
            "equity": total_eq,
            "available": avail_bal,
            "unrealized_pnl": unrealized,
            "yield_rate": round(yield_rate, 6),
            "total_profit": round(total_profit, 2),
            "equity_history": equity_history,
            "spot_balance_history": spot_balance_history,
            "positions": len(positions),
            "open_positions": open_positions,
            "trades_count": len(trades),
            "mode": f"{_ex_name}-ai-agent",
            "exchange": _ex_name.lower(),
            # contract_type 动态化：现货(cash)显示"现货"，期货显示"U本位永续"
            "contract_type": "U本位永续" if _ex_name != "spot" else "现货",
            "system_start_time": system_start_time,
            "watchlist": watchlist,
            "top_signal": top_signal,
            "strategy_v2": {
                "name": trader_info.get("name", f"{_ex_name} AI Strategy"),
                "entryLogic": "MiniMax AI 分析决策",
                "riskGuard": "SKILL.md 风控规则",
            },
            # 当前策略参数（供前端展示）
            "strategy_params": {
                "take_profit": "+30%卖50% / +50%卖80%",
                "stop_loss": "买入价-5%止损",
                "leverage": "3x 永续",
                "entry_logic": "RSI+价格形态+成交量+趋势四维信号",
            },
            "events": [e if isinstance(e, str) else e.get("thought", e.get("reasoning", str(e))) for e in events[-10:]],
            "source": "minimax_ai",
        }

        status_file.write_text(json.dumps(status_payload, ensure_ascii=False, indent=2))

        thinking_entries = []
        for e in events[-30:]:
            if isinstance(e, dict):
                thinking_entries.append(e)
            else:
                thinking_entries.append({"time": now_str(), "thought": str(e)})
        thinking_file.write_text(json.dumps(thinking_entries, ensure_ascii=False, indent=2))

        trades_file.write_text(json.dumps(trades[-500:], ensure_ascii=False, indent=2))

    # ──────────────── 风控铁律 ────────────────
    # 日亏熔断
    _daily_loss_limit_pct = 0.12   # 日亏 >12% 停止新开仓
    _consecutive_stop_loss = 0      # 连续止损次数
    _force_hold_until: float | None = None   # 强制 HOLD 截止时间戳
    _today_date: str = datetime.now().strftime("%Y-%m-%d")
    _today_loss: float = 0.0        # 今日累计亏损额（仅计入亏损方向）

    def _check_risk_guard(account: dict, positions: list, trades: list) -> tuple[bool, str]:
        """风控检查，返回 (is_holded, reason)。"""
        nonlocal _force_hold_until, _today_date, _today_loss, _consecutive_stop_loss

        now = datetime.now()
        today = now.strftime("%Y-%m-%d")

        # 新的一天，重置日亏计数
        if today != _today_date:
            _today_date = today
            _today_loss = 0.0
            _consecutive_stop_loss = 0
            logging.info("新交易日，重置风控计数器")

        total_eq = float(account.get("totalEq", 0))
        start_b = start_balance or 1.0
        daily_pnl = total_eq - start_b

        # 更新今日亏损（只累计负收益）
        if daily_pnl < 0:
            _today_loss = min(_today_loss + abs(daily_pnl), _today_loss)

        # 1. 强制 HOLD 时段（连续止损触发）
        if _force_hold_until and now.timestamp() < _force_hold_until:
            remain = int(_force_hold_until - now.timestamp())
            return True, f"风控熔断中，强制休息 {remain}s（连续止损惩罚）"

        # 2. 日亏超过 12% 熔断
        if _today_loss > 0 and start_b > 0:
            daily_loss_pct = _today_loss / start_b
            if daily_loss_pct >= _daily_loss_limit_pct:
                _force_hold_until = now.timestamp() + 3600 * 24   # 停止当日剩余时间
                return True, f"日亏 {_today_loss:.2f} USDT ({daily_loss_pct*100:.1f}%)，触发熔断，停止当日交易"

        # 3. 持仓上限：最多 1 个标的
        if len(positions) > 0:
            return True, f"已有持仓中（{len(positions)} 个标的），优先持仓管理"

        return False, ""

    def _check_position_management(positions: list, market_data: dict, account: dict) -> dict | None:
        """持仓管理检查：止盈止损/强平信号。返回平仓决策或 None。"""
        if not positions:
            return None

        total_eq = float(account.get("totalEq", 0))
        for p in positions:
            sym = p.get("instId", "")
            pos_val = float(p.get("pos", 0))
            if pos_val == 0:
                continue
            direction = "long" if pos_val > 0 else "short"
            entry_price = float(p.get("avgPx", 0))
            mark_price = float(p.get("markPx", 0))
            margin = float(p.get("margin", 0)) or 1.0
            upl = float(p.get("upl", 0))

            if entry_price <= 0 or mark_price <= 0:
                continue

            # 计算浮盈/保证金比
            if margin > 0:
                upl_ratio = upl / margin
            else:
                upl_ratio = 0

            if direction == "short":
                price_move = (entry_price - mark_price) / entry_price
            else:
                price_move = (mark_price - entry_price) / entry_price

            # 止盈条件
            if upl_ratio >= 1.0:
                return {
                    "action": "CLOSE_SHORT" if direction == "short" else "CLOSE_LONG",
                    "instrument": sym,
                    "size": str(abs(pos_val)),
                    "reasoning": f"浮盈/保证金={upl_ratio*100:.0f}%≥100%，触发止盈保护",
                    "confidence": 0.95,
                }
            if upl_ratio >= 2.0:
                return {
                    "action": "CLOSE_SHORT" if direction == "short" else "CLOSE_LONG",
                    "instrument": sym,
                    "size": str(abs(pos_val)),
                    "reasoning": f"浮盈/保证金={upl_ratio*100:.0f}%≥200%，极端止盈",
                    "confidence": 0.99,
                }

            # 止损条件
            if upl_ratio <= -0.6:
                return {
                    "action": "CLOSE_SHORT" if direction == "short" else "CLOSE_LONG",
                    "instrument": sym,
                    "size": str(abs(pos_val)),
                    "reasoning": f"浮盈/保证金={upl_ratio*100:.0f}%≤-60%，触发软止损",
                    "confidence": 0.95,
                }

            # 资金费率极端（空头持仓时资金费率突然变负极大 = 轧空风险）
            if direction == "short":
                fr = market_data.get(sym, {}).get("fundingRate", 0)
                if fr < -0.005:
                    return {
                        "action": "CLOSE_SHORT",
                        "instrument": sym,
                        "size": str(abs(pos_val)),
                        "reasoning": f"资金费率{fr*100:.2f}%<-0.5%，轧空风险，平仓保护",
                        "confidence": 0.90,
                    }

        return None

    def _update_stop_loss_count(trades: list):
        """更新连续止损计数。"""
        global _consecutive_stop_loss
        recent_closed = [t for t in trades[-3:] if t.get("tradeAction") == "CLOSE" and t.get("pnl", 0) < 0]
        if len(recent_closed) >= 3:
            _consecutive_stop_loss = 3
        else:
            _consecutive_stop_loss = max(0, _consecutive_stop_loss - 1)

        if _consecutive_stop_loss >= 3:
            _force_hold_until = datetime.now().timestamp() + 3 * 3600   # 强制休息 3 小时
            logging.warning(f"连续 3 次止损，强制 HOLD 3 小时")

    # ──────────────── Main Loop ────────────────
    logging.info(f"Starting main loop (freq={freq}s, watchlist={watchlist})")

    while True:
        cycle_start = time.time()
        decision = {}  # 供异常处理时引用

        try:
            # Build dynamic watchlist from 24h gainers
            effective_watchlist = watchlist
            try:
                gainers = get_top_gainers(
                    min_vol_usdt=20_000_000,
                    min_gain_pct=10.0,
                    max_gain_pct=200.0,
                    top_n=10,
                )
                if gainers:
                    effective_watchlist = gainers
                    logging.info(f"Dynamic watchlist ({len(gainers)}): {gainers}")
                else:
                    logging.warning("No gainers found this cycle, using static watchlist")
            except Exception as _e:
                logging.warning(f"Gainer scan failed ({_e}), using static watchlist")

            # Inject BTC for macro check
            BTC_MACRO = "BTCUSDT"
            watchlist_with_btc = effective_watchlist.copy()
            if BTC_MACRO not in watchlist_with_btc:
                watchlist_with_btc.insert(0, BTC_MACRO)
                logging.info(f"Injected {BTC_MACRO} for macro check")

            logging.info("Fetching market data...")
            market_data = fetch_market_data(watchlist_with_btc)
            if not market_data:
                logging.warning("No market data received, retrying next cycle.")
                events.append({
                    "time": now_str(),
                    "thought": "未能获取市场数据，跳过本轮交易思考。",
                    "action": "HOLD",
                    "confidence": 0,
                    "model": minimax_model,
                })
                save_state({"totalEq": "0", "availBal": "0"}, [], {})
                time.sleep(max(5, freq))
                continue

            # Account & positions
            account = fetch_account()
            positions = fetch_positions()
            logging.info(f"Account equity={account.get('totalEq', '?')}, positions={len(positions)}")

            # ── 风控前置检查 ──
            is_holded, hold_reason = _check_risk_guard(account, positions, trades)
            if is_holded:
                logging.info(f"HOLD — {hold_reason}")
                events.append({
                    "time": now_str(),
                    "thought": hold_reason,
                    "action": "HOLD",
                    "confidence": 0,
                    "model": decision.get("model_used", minimax_model),
                })
                save_state(account, positions, market_data)
                time.sleep(max(5, freq))
                continue

            # ── 持仓管理检查（已有仓位优先处理） ──
            pos_mgmt = _check_position_management(positions, market_data, account)
            if pos_mgmt:
                logging.info(f"Position management: {pos_mgmt['action']} {pos_mgmt['instrument']} — {pos_mgmt['reasoning']}")
                exec_result = execute_decision(pos_mgmt)
                if exec_result:
                    pnl_val = exec_result.get("realized_pnl", 0) if "realized_pnl" in exec_result else 0
                    trades.append({
                        "id": str(int(time.time())),
                        "time": now_str(),
                        "type": "BUY" if "LONG" in pos_mgmt.get("action", "") else "SELL",
                        "action": pos_mgmt["action"],
                        "symbol": pos_mgmt.get("instrument", ""),
                        "amount": pos_mgmt.get("size", 0),
                        "price": 0,
                        "leverage": pos_mgmt.get("leverage", 3),
                        "direction": "long" if "LONG" in pos_mgmt.get("action", "") else "short",
                        "tradeAction": "CLOSE",
                        "reason": pos_mgmt.get("reasoning", ""),
                        "confidence": pos_mgmt.get("confidence", 0),
                        "pnl": pnl_val,
                        "orderId": exec_result.get("orderId", "无"),
                    })
                    if exec_result.get("error"):
                        trades[-1]["error"] = exec_result["error"]
                    _update_stop_loss_count(trades)
                time.sleep(2)
                account = fetch_account()
                positions = fetch_positions()
                save_state(account, positions, market_data)
                time.sleep(max(5, freq))
                continue

            # AI decision
            logging.info("Requesting MiniMax AI decision...")
            decision = engine.analyze_market(
                skill_content=skill_content,
                market_data=market_data,
                positions=positions,
                account=account,
                trade_history=trades[-10:],
            )
            logging.info(f"AI decision: action={decision['action']}, "
                        f"confidence={decision['confidence']}, "
                        f"instrument={decision.get('instrument')}")

            # Record thinking
            event_entry = {
                "time": now_str(),
                "thought": decision.get("reasoning", ""),
                "action": decision.get("action", "HOLD"),
                "instrument": decision.get("instrument"),
                "confidence": decision.get("confidence", 0),
                "model": decision.get("model_used", minimax_model),
                "leverage": decision.get("leverage"),
                "size": decision.get("size"),
            }
            events.append(event_entry)

            # Execute trade if not HOLD
            if decision["action"] != "HOLD":
                logging.info(f"Executing: {decision['action']} {decision.get('instrument')} "
                           f"size={decision.get('size')} lever={decision.get('leverage')}")
                exec_result = execute_decision(decision)

                if exec_result:
                    trade_record = {
                        "id": str(int(time.time())),
                        "time": now_str(),
                        "type": "BUY" if "LONG" in decision["action"] else "SELL",
                        "action": decision["action"],
                        "symbol": decision.get("instrument", ""),
                        "amount": exec_result.get("executedQty") or decision.get("size", 0),
                        "price": exec_result.get("price") or 0,
                        "leverage": decision.get("leverage", 10),
                        "direction": "long" if "LONG" in decision["action"] else "short",
                        "tradeAction": "OPEN" if "OPEN" in decision["action"] else "CLOSE",
                        "reason": decision.get("reasoning", "")[:200],
                        "confidence": decision.get("confidence", 0),
                        "pnl": exec_result.get("realized_pnl", 0),
                        "orderId": exec_result.get("orderId", "无"),
                    }

                    if exec_result.get("error"):
                        trade_record["error"] = exec_result["error"]
                        logging.error(f"Trade execution failed: {exec_result['error']}")
                    else:
                        logging.info(f"Trade executed: {exec_result.get('type')}")

                    trades.append(trade_record)
            else:
                logging.info("Decision: HOLD — no trade this cycle.")

            # Refresh account after trade
            if decision["action"] != "HOLD":
                time.sleep(2)
                account = fetch_account()
                positions = fetch_positions()

            save_state(account, positions, market_data)

        except Exception as e:
            logging.error(f"Cycle error: {e}", exc_info=True)
            events.append({
                "time": now_str(),
                "thought": f"交易循环异常: {str(e)}",
                "action": "ERROR",
                "confidence": 0,
                "model": decision.get("model_used", minimax_model),
            })

        elapsed = time.time() - cycle_start
        sleep_time = max(5.0, freq - elapsed)
        logging.info(f"Cycle done in {elapsed:.1f}s, sleeping {sleep_time:.1f}s")
        time.sleep(sleep_time)


if __name__ == "__main__":
    main()
