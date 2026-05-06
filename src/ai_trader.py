"""
OpenClaw AI Trader — Binance / OKX 双交易所支持 + MiniMax AI Engine.
Runs as a subprocess per trader instance, managed by server.py.
交易所由 EXCHANGE_TYPE 环境变量决定（binance 或 okx）。
"""
from __future__ import annotations

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

    if not minimax_key:
        logging.error("MINIMAX_API_KEY not set. Cannot start AI engine.")
        return

    engine = MiniMaxEngine(api_key=minimax_key, model=minimax_model, base_url=minimax_base_url)
    logging.info(f"MiniMax engine initialized: model={minimax_model}")

    # State files
    status_file = session_dir / "status.json"
    thinking_file = session_dir / "thinking.json"
    trades_file = session_dir / "trades.json"

    # Load previous state
    events: list[dict] = []
    trades: list[dict] = []
    equity_history: list[dict] = []
    start_balance: float | None = None

    if status_file.exists():
        try:
            old = json.loads(status_file.read_text(encoding="utf-8"))
            equity_history = old.get("equity_history", [])
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
        bal = get_balance("USDT")
        if bal:
            return bal
        return {"totalEq": "0", "availBal": "0"}

    def fetch_positions() -> list:
        # 现货无持仓概念，直接返回空
        return []

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
                # 现货：买入=做多(OPEN_LONG)，卖出=做空(OPEN_SHORT)
                side = "BUY" if action == "OPEN_LONG" else "SELL"
                sz = str(max(1, int(round(float(decision.get("size", 1))))))

                result = place_order(
                    inst_id=inst_id,
                    side=side,
                    ord_type="MARKET",
                    sz=sz,
                    td_mode="cash",  # 现货
                )
                if not result:
                    return {"type": action, "error": "Order placement failed"}

                return {"type": action, "result": result}

            elif action in ("CLOSE_LONG", "CLOSE_SHORT"):
                # 现货平仓：平多仓=卖出，平空仓=买入
                close_side = "SELL" if action == "CLOSE_LONG" else "BUY"
                sz = str(max(1, int(round(float(decision.get("size", 1))))))
                result = place_order(
                    inst_id=inst_id,
                    side=close_side,
                    ord_type="MARKET",
                    sz=sz,
                    td_mode="cash",
                )
                if not result:
                    return {"type": action, "error": "Close order failed"}
                return {"type": action, "result": result}

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
        avail_bal = float(details[0].get("availBal", 0)) if details else float(account.get("availBal", 0))
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
            "positions": len(positions),
            "open_positions": open_positions,
            "trades_count": len(trades),
            "mode": f"{_ex_name}-ai-agent",
            "exchange": _ex_name.lower(),
            # contract_type 动态化：现货(cash)显示"现货"，期货显示"USDT-M永续"
            "contract_type": "现货",
            "system_start_time": system_start_time,
            "watchlist": watchlist,
            "top_signal": top_signal,
            "events": [e if isinstance(e, str) else e.get("thought", e.get("reasoning", str(e))) for e in events[-10:]],
            "source": "minimax_ai",
            "strategy_v2": {
                "name": trader_info.get("name", f"{_ex_name} AI Strategy"),
                "entryLogic": "MiniMax AI 分析决策",
                "riskGuard": "SKILL.md 风控规则",
            },
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

    # ──────────────── Main Loop ────────────────
    logging.info(f"Starting main loop (freq={freq}s, watchlist={watchlist})")

    while True:
        cycle_start = time.time()

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
                "model": minimax_model,
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
                        "amount": decision.get("size", 0),
                        "price": 0,
                        "leverage": decision.get("leverage", 10),
                        "direction": "long" if "LONG" in decision["action"] else "short",
                        "tradeAction": "OPEN" if "OPEN" in decision["action"] else "CLOSE",
                        "reason": decision.get("reasoning", "")[:200],
                        "confidence": decision.get("confidence", 0),
                        "pnl": exec_result.get("realized_pnl", 0),
                    }

                    inst = decision.get("instrument", "")
                    if inst in market_data:
                        ticker = market_data[inst].get("ticker", {})
                        trade_record["price"] = float(ticker.get("last", 0))

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
                "model": minimax_model,
            })

        elapsed = time.time() - cycle_start
        sleep_time = max(5.0, freq - elapsed)
        logging.info(f"Cycle done in {elapsed:.1f}s, sleeping {sleep_time:.1f}s")
        time.sleep(sleep_time)


if __name__ == "__main__":
    main()
