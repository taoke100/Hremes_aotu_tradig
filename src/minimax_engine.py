"""
MiniMax AI Decision Engine.
Uses OpenAI-compatible SDK to call MiniMax M2.7 for trade decisions.
"""
from __future__ import annotations


import json
import logging
import re
from datetime import date
from typing import Any

from openai import OpenAI

logger = logging.getLogger(__name__)

PARSE_FAILURE_PREFIX = "AI 输出解析失败。"

DECISION_SCHEMA = """\
You must respond with ONLY a valid JSON object (no markdown, no code blocks).
The JSON must follow this exact schema:

{
  "action": "OPEN_LONG" | "OPEN_SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" | "HOLD",
  "instrument": "BTC-USDT-SWAP",
  "size": 0.1,
  "leverage": 10,
  "reasoning": "Brief Chinese reasoning in one line",
  "confidence": 0.85,
  "stop_loss": 80000.0,
  "take_profit": 90000.0
}

Field rules:
- action: Required. HOLD means do nothing this cycle.
- instrument: Required for OPEN/CLOSE actions. OKX SWAP format.
- size: Required for OPEN actions. Number of contracts.
- leverage: Required for OPEN actions. Integer 1-125.
- reasoning: Required. Explain briefly in Chinese, no line breaks, <= 120 Chinese characters.
- confidence: Required. Float 0.0-1.0.
- stop_loss: Required for OPEN actions. Price level.
- take_profit: Required for OPEN actions. Price level.
"""

DEFAULT_HOLD = {
    "action": "HOLD",
    "instrument": None,
    "size": 0,
    "leverage": 0,
    "reasoning": "AI 决策解析失败，默认观望。",
    "confidence": 0.0,
    "stop_loss": None,
    "take_profit": None,
}


class MiniMaxEngine:
    # 连续超时阈值，触发 DeepSeek 备用切换
    TIMEOUT_THRESHOLD = 3

    def __init__(self, api_key: str, model: str = "MiniMax-M2.7",
                 base_url: str = "https://api.minimax.io/v1",
                 deepseek_key: str = "",
                 deepseek_model: str = "deepseek-chat"):
        self.primary = OpenAI(api_key=api_key, base_url=base_url)
        self.primary_model = model
        self.primary_base_url = base_url
        # DeepSeek 备用客户端
        if deepseek_key:
            self.deepseek = OpenAI(api_key=deepseek_key,
                                   base_url="https://api.deepseek.com/v1")
        else:
            self.deepseek = None
        self.deepseek_model = deepseek_model
        self._consecutive_failures = 0
        self._using_fallback = False

    def analyze_market(
        self,
        skill_content: str,
        market_data: dict[str, Any],
        positions: list[dict],
        account: dict[str, Any],
        trade_history: list[dict],
    ) -> dict[str, Any]:
        """
        Send market data + SKILL instructions to MiniMax and return a structured trade decision.
        """
        system_prompt = self._build_system_prompt(skill_content)
        user_prompt = self._build_user_prompt(market_data, positions, account, trade_history)

        try:
            response = self._create_completion(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.3,
                max_tokens=2000,
                prefer_json=True,
            )
            content = response.choices[0].message.content.strip()
            logger.info(f"MiniMax raw response: {content[:500]}")

            decision = self._parse_decision(content)

            if self._is_parse_failure(decision):
                logger.warning("First parse failed, retrying with JSON-only prompt")
                retry_content = self._retry_completion(
                    system_prompt, user_prompt, content,
                    temperature=0.1, max_tokens=1200,
                )
                if retry_content:
                    logger.info(f"MiniMax retry response: {retry_content[:300]}")
                    decision = self._parse_decision(retry_content)

            self._consecutive_failures = 0  # 成功，重置计数器
            self._using_fallback = False
            decision["model_used"] = self.primary_model  # 记录实际使用的模型
            return decision

        except Exception as e:
            err_str = str(e).lower()
            is_timeout = any(x in err_str for x in [
                "timeout", "timed out", "connect timeout",
                "read timeout", "connection error", "ECONNRESET",
                "connectionrefused", "name or service not known",
            ])
            self._consecutive_failures += 1
            logger.error(
                f"MiniMax API error (consecutive_failures={self._consecutive_failures}): {e}"
            )

            if is_timeout and self._consecutive_failures >= self.TIMEOUT_THRESHOLD:
                return self._try_deepseek_fallback(
                    skill_content, market_data, positions, account, trade_history
                )
            return {**DEFAULT_HOLD, "reasoning": f"MiniMax API 调用失败: {str(e)[:60]}", "model_used": self.primary_model}

    def _create_completion(
        self,
        *,
        messages: list[dict[str, str]],
        temperature: float,
        max_tokens: int,
        prefer_json: bool = False,
    ):
        kwargs = {
            "model": self.primary_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if prefer_json:
            try:
                return self.primary.chat.completions.create(
                    **kwargs,
                    response_format={"type": "json_object"},
                )
            except Exception:
                pass
        return self.primary.chat.completions.create(**kwargs)

    def _retry_completion(
        self,
        system_prompt: str,
        user_prompt: str,
        prev_content: str,
        temperature: float,
        max_tokens: int,
    ) -> str | None:
        """重试解析失败的情况，返回 content 或 None"""
        try:
            resp = self._create_completion(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                    {"role": "assistant", "content": prev_content},
                    {"role": "user", "content": (
                        "你的上一次回复不是合法 JSON。"
                        "请重新给出最终交易决策，并且只输出一个合法 JSON 对象。"
                        "不要输出 markdown、不要输出代码块、不要输出 <think> 标签。"
                        "如果上一次回复只有分析过程但没有最终结论，请基于同样的市场数据完成最终决策。"
                        "reasoning 必须是一行中文，不要换行，控制在 120 个汉字以内。"
                    )},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
                prefer_json=True,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"Retry completion failed: {e}")
            return None

    def _try_deepseek_fallback(
        self,
        skill_content: str,
        market_data: dict[str, Any],
        positions: list[dict],
        account: dict[str, Any],
        trade_history: list[dict],
    ) -> dict[str, Any]:
        """连续超时3次后切换 DeepSeek 备用"""
        if not self.deepseek:
            logger.warning("DeepSeek fallback unavailable (no API key)")
            return {**DEFAULT_HOLD, "reasoning": "MiniMax 超时3次，DeepSeek 未配置，默认观望"}

        self._using_fallback = True
        logger.warning("=== SWITCHING TO DEEPSEEK FALLBACK (MiniMax timeout x3) ===")

        system_prompt = self._build_system_prompt(skill_content)
        user_prompt = self._build_user_prompt(market_data, positions, account, trade_history)

        try:
            kwargs = {
                "model": self.deepseek_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.3,
                "max_tokens": 2000,
            }
            resp = self.deepseek.chat.completions.create(**kwargs)
            content = resp.choices[0].message.content.strip()
            logger.info(f"DeepSeek fallback response: {content[:500]}")
            decision = self._parse_decision(content)
            self._consecutive_failures = 0  # 备用成功，重置
            decision["model_used"] = self.deepseek_model  # 记录实际使用的模型
            return decision
        except Exception as e:
            logger.error(f"DeepSeek fallback also failed: {e}")
            return {**DEFAULT_HOLD, "reasoning": f"MiniMax 超时3次 + DeepSeek 失败: {str(e)[:40]}", "model_used": self.deepseek_model}

    def _is_parse_failure(self, decision: dict[str, Any]) -> bool:
        reasoning = str(decision.get("reasoning", ""))
        return decision.get("action") == "HOLD" and (
            PARSE_FAILURE_PREFIX in reasoning or "[自动降级为HOLD:" in reasoning
        )

    def _build_system_prompt(self, skill_content: str) -> str:
        return f"""\
你是一个专业的 AI 加密货币交易 Agent，正在参加 OKX AI Trading Challenge 比赛。
你通过 OKX Agent Trade Kit 管理 USDT 本位永续合约交易。

## 你的交易策略 (SKILL)
{skill_content}

## 决策输出格式
{DECISION_SCHEMA}

## 重要规则
1. 每次只能输出一个交易决策
2. 必须严格遵循策略中的风控规则
3. 仓位管理必须合理，不要过度杠杆
4. 倾向于积极交易以积累成交额，不要过于保守地一直 HOLD
5. 所有推理必须用中文
6. 只输出 JSON，不要输出其他任何内容（禁止输出 <think> 标签、禁止输出分析过程、禁止输出任何前缀说明文字）
7. reasoning 必须精简为单行中文，不要换行，控制在 120 个汉字以内
8. 【强制要求】你的输出必须以左花括号 {{ 开头，直接就是一个 JSON 对象，不要有任何其他字符
"""

    def _build_user_prompt(
        self,
        market_data: dict[str, Any],
        positions: list[dict],
        account: dict[str, Any],
        trade_history: list[dict],
    ) -> str:
        sections = ["## 当前市场数据"]
        for inst_id, data in market_data.items():
            ticker = data.get("ticker", {})
            sections.append(f"""
### {inst_id}
- 最新价: {ticker.get('last', 'N/A')}
- 24h涨跌: {ticker.get('lastPx', ticker.get('change24h', 'N/A'))}
- 24h最高: {ticker.get('high24h', 'N/A')}
- 24h最低: {ticker.get('low24h', 'N/A')}
- 24h成交量: {ticker.get('vol24h', 'N/A')}
- 买一价: {ticker.get('bidPx', 'N/A')}
- 卖一价: {ticker.get('askPx', 'N/A')}""")

            # Pre-computed RSI indicators (RSI6=威科夫核心, RSI14=通用)
            rsi_1h  = data.get("rsi_1h")
            rsi_4h  = data.get("rsi_4h")
            rsi_6_1h = data.get("rsi_6_1h")
            rsi_6_4h = data.get("rsi_6_4h")
            if rsi_1h is not None or rsi_4h is not None or rsi_6_1h is not None:
                sections.append(f"\n#### {inst_id} 技术指标 (代码预计算)")
                if rsi_6_1h is not None:
                    sections.append(f"- RSI(6)  1H: {rsi_6_1h}  ← 威科夫策略核心")
                if rsi_1h is not None:
                    sections.append(f"- RSI(14) 1H: {rsi_1h}")
                if rsi_6_4h is not None:
                    sections.append(f"- RSI(6)  4H: {rsi_6_4h}")
                if rsi_4h is not None:
                    sections.append(f"- RSI(14) 4H: {rsi_4h}")

            # K-line data (1H)
            candles_1h = data.get("candles_1h", [])
            if candles_1h:
                sections.append(f"\n#### {inst_id} 1H K线 (最近 {len(candles_1h)} 根)")
                sections.append("| 时间戳 | 开 | 高 | 低 | 收 | 成交量 |")
                sections.append("|--------|-----|-----|-----|-----|--------|")
                for c in candles_1h:
                    if isinstance(c, list) and len(c) >= 6:
                        sections.append(f"| {c[0]} | {c[1]} | {c[2]} | {c[3]} | {c[4]} | {c[5]} |")

            # K-line data (4H)
            candles_4h = data.get("candles_4h", [])
            if candles_4h:
                sections.append(f"\n#### {inst_id} 4H K线 (最近 {len(candles_4h)} 根)")
                sections.append("| 时间戳 | 开 | 高 | 低 | 收 | 成交量 |")
                sections.append("|--------|-----|-----|-----|-----|--------|")
                for c in candles_4h:
                    if isinstance(c, list) and len(c) >= 6:
                        sections.append(f"| {c[0]} | {c[1]} | {c[2]} | {c[3]} | {c[4]} | {c[5]} |")

            # Funding rate (Binance 期货，从 get_funding_rate 直接返回 dict)
            funding_rate = data.get("fundingRate")
            next_funding_time = data.get("nextFundingTime")
            if funding_rate is not None:
                sections.append(f"\n#### {inst_id} 资金费率 (Binance 期货)")
                pct = funding_rate * 100
                sections.append(f"- 当前费率: {pct:.4f}% / 8h")
                if next_funding_time:
                    import datetime as dt
                    next_ts = dt.datetime.fromtimestamp(next_funding_time / 1000, tz=dt.timezone.utc)
                    sections.append(f"- 下次结算: {next_ts.strftime('%m-%d %H:%M')} UTC")
                # 资金费率安全提示
                abs_fr = abs(funding_rate)
                if abs_fr > 0.001:
                    sections.append(f"⚠️ 极端费率 |abs|={pct:.3f}%，建议跳过或减半仓")
                elif abs_fr > 0.0005:
                    sections.append(f"⚡ 注意费率偏{funding_rate>0 and '正(+)' or '负(-)'}")


            # Open interest (Binance 期货持仓量)
            open_interest = data.get("openInterest")
            if open_interest is not None:
                sections.append(f"\n#### {inst_id} 持仓量 (OI)")
                sections.append(f"- OI 名义价值: ${open_interest:,.0f} USD")

        # Account info
        details = account.get("details", [])
        avail_bal = details[0].get("availBal", "N/A") if details else account.get("availBal", "N/A")
        sections.append(f"\n## 账户状态")
        sections.append(f"- 可用余额 (USDT): {avail_bal}")
        sections.append(f"- 总权益: {account.get('totalEq', 'N/A')}")
        sections.append(f"- 已用保证金: {account.get('imr', 'N/A')}")

        # Positions
        if positions:
            sections.append(f"\n## 当前持仓 ({len(positions)} 个)")
            for p in positions:
                sections.append(f"""
### {p.get('instId', 'N/A')}
- 方向: {'多' if p.get('posSide') == 'long' or float(p.get('pos', 0)) > 0 else '空'}
- 数量: {p.get('pos', 'N/A')}
- 开仓均价: {p.get('avgPx', 'N/A')}
- 未实现盈亏: {p.get('upl', 'N/A')} USDT
- 杠杆: {p.get('lever', 'N/A')}x
- 保证金: {p.get('margin', p.get('imr', 'N/A'))} USDT""")
        else:
            sections.append("\n## 当前持仓: 无")

        # Recent trades
        if trade_history:
            recent = trade_history[-5:]
            sections.append(f"\n## 最近交易 (最新 {len(recent)} 笔)")
            for t in recent:
                sections.append(f"- {t.get('time', 'N/A')} | {t.get('action', t.get('type', 'N/A'))} | "
                              f"{t.get('instrument', t.get('symbol', 'N/A'))} | "
                              f"PnL: {t.get('pnl', 'N/A')} USDT")

        # Competition phase info
        from datetime import date
        comp_start = date(2026, 5, 6)
        comp_end = date(2026, 5, 20)
        today = date.today()
        elapsed = (today - comp_start).days
        remaining = (comp_end - today).days
        if elapsed <= 3:
            phase = "初期阶段（积极交易，积累成交额）"
        elif elapsed <= 10:
            phase = "中期阶段（稳健交易，赚取收益）"
        else:
            phase = "后期锁定（保守防守，锁定利润）"

        sections.append(f"\n## 比赛阶段信息")
        sections.append(f"- 比赛开始日期: 2026-05-06")
        sections.append(f"- 当前日期: {today}")
        sections.append(f"- 已过天数: {elapsed} 天")
        sections.append(f"- 剩余天数: {remaining} 天")
        sections.append(f"- 当前阶段: {phase}")

        sections.append("\n请根据以上数据和你的策略，给出本轮交易决策。")
        return "\n".join(sections)

    def _parse_decision(self, content: str) -> dict[str, Any]:
        """Parse the LLM response into a structured decision dict."""
        cleaned = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()

        for candidate in self._iter_json_candidates(cleaned):
            decision = self._try_parse_json_candidate(candidate)
            if decision is not None:
                return decision

        partial_decision = self._extract_partial_decision(cleaned)
        if partial_decision is not None:
            logger.warning("Recovered MiniMax decision from partial JSON payload")
            return partial_decision

        logger.warning(f"Failed to parse MiniMax decision: {cleaned[:300]}")
        return {**DEFAULT_HOLD, "reasoning": f"{PARSE_FAILURE_PREFIX}原始输出: {cleaned[:200]}"}

    def _iter_json_candidates(self, content: str):
        seen: set[str] = set()

        # Step 0: Strip <think>...</think> thinking blocks (MiniMax often wraps analysis in these)
        stripped = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()

        for candidate in [content, stripped, *self._extract_code_blocks(content), *self._extract_json_objects(content)]:
            candidate = candidate.strip()
            if not candidate or candidate in seen:
                continue

            # Skip candidates that are clearly non-JSON narrative text
            # Find the first '{' and skip everything before it
            first_brace = candidate.find("{")
            if first_brace == -1:
                continue  # No JSON found at all, skip
            if first_brace > 0:
                candidate = candidate[first_brace:]

            if candidate.strip():
                seen.add(candidate)
                yield candidate

    def _extract_code_blocks(self, content: str) -> list[str]:
        blocks: list[str] = []
        for match in re.finditer(r"```(?:json)?\s*(.*?)```", content, flags=re.DOTALL | re.IGNORECASE):
            blocks.append(match.group(1).strip())
        return blocks

    def _extract_json_objects(self, content: str) -> list[str]:
        objects: list[str] = []
        start: int | None = None
        depth = 0
        in_string = False
        escaped = False

        for idx, ch in enumerate(content):
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue

            if ch == '"':
                in_string = True
            elif ch == "{":
                if depth == 0:
                    start = idx
                depth += 1
            elif ch == "}" and depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    objects.append(content[start:idx + 1])
                    start = None

        return objects

    def _try_parse_json_candidate(self, candidate: str) -> dict[str, Any] | None:
        for repaired in self._repair_json_candidates(candidate):
            try:
                decision = json.loads(repaired)
            except json.JSONDecodeError:
                continue
            if isinstance(decision, dict):
                return self._validate_decision(decision)
        return None

    def _repair_json_candidates(self, candidate: str):
        stripped = candidate.strip().lstrip("\ufeff")
        yield stripped

        normalized = self._escape_json_string_controls(stripped)
        if normalized != stripped:
            yield normalized

        no_trailing_commas = re.sub(r",(\s*[}\]])", r"\1", normalized)
        if no_trailing_commas != normalized:
            yield no_trailing_commas

    def _extract_partial_decision(self, content: str) -> dict[str, Any] | None:
        stripped = re.sub(r"^```(?:json)?\s*", "", content, flags=re.IGNORECASE).strip()
        if not stripped:
            return None

        action = self._extract_partial_field(stripped, "action", is_string=True)
        instrument = self._extract_partial_field(stripped, "instrument", is_string=True)
        size = self._extract_partial_field(stripped, "size")
        leverage = self._extract_partial_field(stripped, "leverage")
        reasoning = self._extract_partial_field(stripped, "reasoning", is_string=True)
        confidence = self._extract_partial_field(stripped, "confidence")
        stop_loss = self._extract_partial_field(stripped, "stop_loss")
        take_profit = self._extract_partial_field(stripped, "take_profit")

        if not any([action, instrument, reasoning, size, leverage, confidence, stop_loss, take_profit]):
            return None

        decision: dict[str, Any] = {
            "action": action or "HOLD",
            "instrument": instrument,
            "size": size if size is not None else 0,
            "leverage": leverage if leverage is not None else 0,
            "reasoning": reasoning or "模型输出被截断，已按可恢复字段解析。",
            "confidence": confidence if confidence is not None else 0.5,
            "stop_loss": stop_loss,
            "take_profit": take_profit,
        }
        return self._validate_decision(decision)

    def _extract_partial_field(self, text: str, key: str, is_string: bool = False):
        match = re.search(rf'"{re.escape(key)}"\s*:\s*', text)
        if not match:
            return None

        idx = match.end()
        length = len(text)
        while idx < length and text[idx].isspace():
            idx += 1
        if idx >= length:
            return None

        if text[idx] == '"':
            value, _ = self._read_partial_json_string(text, idx + 1)
            decoded = self._decode_partial_json_string(value)
            return decoded if is_string else decoded

        end = idx
        while end < length and text[end] not in ",}\n\r":
            end += 1
        raw = text[idx:end].strip()
        if not raw or raw == "null":
            return None
        return raw

    def _read_partial_json_string(self, text: str, start: int) -> tuple[str, bool]:
        chars: list[str] = []
        escaped = False

        for idx in range(start, len(text)):
            ch = text[idx]
            if escaped:
                chars.append(ch)
                escaped = False
                continue
            if ch == "\\":
                chars.append(ch)
                escaped = True
                continue
            if ch == '"':
                return "".join(chars), True
            chars.append(ch)

        return "".join(chars), False

    def _decode_partial_json_string(self, value: str) -> str:
        return (
            value
            .replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
            .replace('\\"', '"')
            .replace("\\\\", "\\")
            .strip()
        )

    def _escape_json_string_controls(self, text: str) -> str:
        output: list[str] = []
        in_string = False
        escaped = False

        for ch in text:
            if in_string:
                if escaped:
                    output.append(ch)
                    escaped = False
                    continue
                if ch == "\\":
                    output.append(ch)
                    escaped = True
                    continue
                if ch == '"':
                    output.append(ch)
                    in_string = False
                    continue
                if ch == "\n":
                    output.append("\\n")
                    continue
                if ch == "\r":
                    output.append("\\r")
                    continue
                if ch == "\t":
                    output.append("\\t")
                    continue
                output.append(ch)
                continue

            output.append(ch)
            if ch == '"':
                in_string = True

        return "".join(output)

    def _validate_decision(self, decision: dict) -> dict[str, Any]:
        """Validate and normalize a decision dict."""
        valid_actions = {"OPEN_LONG", "OPEN_SHORT", "CLOSE_LONG", "CLOSE_SHORT", "HOLD"}
        action = str(decision.get("action", "HOLD")).upper()
        if action not in valid_actions:
            action = "HOLD"

        instrument = decision.get("instrument")
        if instrument is not None:
            instrument = str(instrument).strip() or None

        size_default = 0 if action == "HOLD" else 1
        size = max(0, int(round(self._parse_number(decision.get("size"), size_default))))
        leverage = max(0, int(round(self._parse_number(decision.get("leverage"), 10))))
        confidence = min(1.0, max(0.0, self._parse_number(decision.get("confidence"), 0.5)))

        result = {
            "action": action,
            "instrument": instrument,
            "size": size,
            "leverage": leverage,
            "reasoning": str(decision.get("reasoning", "无推理说明")),
            "confidence": confidence,
            "stop_loss": decision.get("stop_loss"),
            "take_profit": decision.get("take_profit"),
        }

        # Ensure required fields for OPEN actions
        if action.startswith("OPEN") and (not result["instrument"] or result["size"] < 1):
            logger.warning("OPEN action missing instrument or size, falling back to HOLD")
            result["action"] = "HOLD"
            result["reasoning"] += " [自动降级为HOLD: 缺少必要参数]"

        if action.startswith("OPEN") and (result["stop_loss"] is None or result["take_profit"] is None):
            logger.warning("OPEN action missing stop_loss or take_profit, falling back to HOLD")
            result["action"] = "HOLD"
            result["reasoning"] += " [自动降级为HOLD: 缺少止盈止损参数]"

        return result

    def _parse_number(self, value: Any, default: float) -> float:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        if value is None:
            return float(default)
        match = re.search(r"-?\d+(?:\.\d+)?", str(value))
        if match:
            return float(match.group(0))
        return float(default)
