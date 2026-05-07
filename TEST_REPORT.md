# Hermes AI Trading Bot v1.3.1-ts 测试验收报告

**测试环境**: http://127.0.0.1:8889
**测试时间**: 2026-05-08
**API Base**: http://127.0.0.1:8889

## 测试结果汇总

| TC | 预期 | 实际 | 结果 |
|----|------|------|------|
| TC-01 | 返回所有交易员，JSON 第一层包含 name/ai_provider/exchange/scan_frequency | HTTP 200，返回 Ximeng/cidao/JsonBot/keni/OkxBot/hm 共 6 个交易员，各字段齐全 | PASS |
| TC-02 | HTTP 200，返回包含 status=stopped | HTTP 200，`{"status":"stopped","id":"testTC02",...}` | PASS |
| TC-03 | HTTP 409 Conflict | HTTP 409，`{"error":"Trader 'testTC02' already exists"}` | PASS |
| TC-04 | HTTP 400 Bad Request | HTTP 400，`{"error":"id is required"}` | PASS |
| TC-05 | HTTP 200，config 文件中 testTC02 已删除 | HTTP 200 返回 `{"status":"deleted"}`，但 config 文件和 traders 列表中 testTC02 仍存在 | **FAIL** |
| TC-06 | 返回 server:ok | HTTP 200，`{"server":"ok","traders":{...},"uptime":549}` | PASS |
| TC-07 | 返回包含 rsi_1h、candles_1h、fundingRate | HTTP 200，响应包含 `rsi_1h:25.95`、`candles_1h:[...]`、`fundingRate:-0.00002065` | PASS |
| TC-08 | 返回策略内容非空 | HTTP 200，`skill_content` 包含完整的威科夫 RSI 策略文档（数千字） | PASS |

## TC-05 失败分析

**问题**: DELETE /api/traders/testTC02 返回 200 `{"status":"deleted"}`，但 testTC02 在 config 文件和 API 响应中仍然存在。

**根因**: server.ts 中 `saveSystemConfig()` 函数的合并逻辑存在 bug：

```typescript
traders: { ...current.traders, ...(updates.traders || {}) }
```

当 `updates.traders` 中删除了某个 key（用 `delete cfg.traders[id]`），但该 key 在 `current.traders` 中仍存在时，spread 合并后该 key 不会消失（因为 spread 是后者覆盖前者，前者有而后者没有的 key 会保留）。

正确行为应为：`saveSystemConfig` 在接收完整 SystemConfig 对象时应直接覆盖，而非与 current 合并。

## 最终状态确认

- testTC02 仍残留于 `~/binance-trading-bot-ts/data/system_config.json`
- testTC02 仍出现在 `/api/traders` 和 `/api/health` 响应中
- 手动修复需从 system_config.json 中移除 testTC02 条目

## 通过率: 7/8 (87.5%)
