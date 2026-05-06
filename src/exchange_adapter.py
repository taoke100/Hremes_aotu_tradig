"""
exchange_adapter.py — 交易所客户端统一适配器.
根据 system_config.json 中配置的 exchange 类型，自动选择:
  - "binance" → binance_client
  - "okx"     → okx_client
"""
from __future__ import annotations
import logging
from typing import Any

logger = logging.getLogger(__name__)

_client: Any = None
_exchange_type: str = "okx"


def init_client(exchange: str = "okx"):
    global _client, _exchange_type
    _exchange_type = exchange.lower()
    if _exchange_type == "binance":
        import binance_client as c
        logger.info("交易所适配器: Binance")
    elif _exchange_type == "okx":
        import okx_client as c
        logger.info("交易所适配器: OKX")
    else:
        raise ValueError(f"不支持的交易所: {exchange}，支持: binance, okx")
    _client = c


def __getattr__(name: str):
    if _client is None:
        raise RuntimeError("exchange_adapter 未初始化，请先调用 init_client()")
    return getattr(_client, name)


def get_exchange_type() -> str:
    return _exchange_type
