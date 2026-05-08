# 默认参数测试报告
**测试时间**: 2026-05-08 10:40
**服务端口**: 8889

---

## 1. API 端点测试结果

### GET /api/system/config
**状态**: 200 OK

**响应结构** (根级别字段):
- `traders` - 交易员字典
- `ai_providers` - AI 服务商字典
- `exchanges` - 交易所字典

**缺失字段** (前端代码期望但未返回):
- `web_brand` - 前端期望从 API 读取，已有的兜底默认值 `'AI Trading Kit'`
- `web_title` - 前端期望从 API 读取，已有的兜底默认值 `'AI 自动交易'`

**AI 服务商** (`ai_providers`):
| Key | Type | API Key | Base URL | Model |
|-----|------|---------|----------|-------|
| minimax_default | deepseek | `***` | https://api.deepseek.com | deepseek-chat |
| DeepSeek | deepseek | `***` | https://api.deepseek.com | deepseek-chat |
| deepseek | deepseek | (empty) | https://api.deepseek.com | deepseek-chat |
| ds_test1 | null | - | - | - |
| qwen_trader1 | null | - | - | - |

**交易所** (`exchanges`):
| Key | Type | API Key | Secret Key | Passphrase |
|-----|------|---------|------------|------------|
| binance | binance | `alii59...kN1v` | `jx0Qok3u...` | (none) |
| okx_Ag | okx | `7667d8...ed4c` | `730AD002...` | `Ab@123456.` |

### GET /api/traders
**状态**: 200 OK

**交易员列表** (4个):
| ID | 名称 | 状态 | 交易所 | 扫描频率 | 策略文件 |
|----|------|------|--------|----------|---------|
| Ximeng (西蒙) | running | binance | 30s | SKILL_WYCKOFF_RSI_BINANCE_V1.md |
| cidao (刺刀) | running | binance | 30s | SKILL_WYCKOFF_RSI_BINANCE_V1.md |
| keni (柯尼) | stopped | binance | 30s | (empty) |
| hm (黑妹) | stopped | okx_Ag | 30s | (empty) |

**注意**: `/api/system/config` 返回的 Ximeng/cidao 状态为 `running`，但 `/api/traders` 返回的为 `stopped`。说明两个接口的数据源存在不一致。

### GET /api/market?symbols=BTC,ETH,SOL
**状态**: 200 OK

| Symbol | Price | 24h Change | RSI(6) 1H | RSI 4H | Funding Rate | OI |
|--------|-------|-----------|-----------|--------|-------------|-----|
| BTC | - (empty) | - | - | - | - | 0 |
| ETH | - (empty) | - | - | - | - | 0 |
| SOL | 88.11 | +0.159% | 38.98 | 46.82 | 0.01% | $10.6M |

**问题**: BTC 和 ETH 的 K 线数据为空 (`candles_1h: []`, `candles_4h: []`)，只有 SOL 有完整数据。

---

## 2. 前端响应处理检查 (public/js/app.js)

### fetchSystemSettings() [L1336-1406]
**数据获取**: `GET /api/system/config`

**响应处理流程**:
1. 将响应 JSON 缓存到 `cachedSystemConfig`
2. 从 `settings.web_brand` / `settings.web_title` 填充页面标题和表单项
3. 遍历 `settings.ai_providers` 填充 AI 服务商下拉框
4. 取第一个 AI 服务商的配置填充表单字段 (api_key, base_url, model 等)
5. 遍历 `settings.exchanges` 填充交易所下拉框
6. 取第一个交易所的配置填充 API Key / Secret Key 等

**问题**: 当前 API 响应中无 `web_brand`/`web_title` 字段，前端会使用硬编码的兜底默认值。

### fetchTradersList() [L1466-...]
**数据获取**: `GET /api/traders`

**响应处理流程**:
1. 将响应缓存到 `cachedSystemConfig.traders`
2. 清空 `#traderListContainer`
3. 若无交易员，显示空状态提示
4. 若有交易员，调用 `renderTraderCards()` 渲染顶部并行卡片

**渲染逻辑** (renderTraderCards):
- 根据 `info.status === 'running'` 判断是否显示运行中
- 从 `/{tid}/status.json` 获取 `contract_type` 判断现货/合约
- 显示总收益 `total_profit`，带颜色高亮

---

## 3. 问题汇总

| # | 问题 | 严重程度 | 说明 |
|---|------|---------|------|
| 1 | BTC/ETH 市场数据为空 | 高 | `/api/market` 对 BTCUSDT/ETHUSDT 返回空 K 线，可能是 Binance API 连接问题 |
| 2 | `/api/system/config` 与 `/api/traders` 状态不一致 | 中 | Ximeng/cidao 在 system/config 中状态为 running，在 traders 中为 stopped |
| 3 | 多个 AI Provider 的 api_key 为空或 null | 低 | ds_test1, qwen_trader1 为 null；deepseek 的 api_key 为空字符串 |
| 4 | web_brand/web_title 未持久化 | 低 | API 不返回这两个字段，前端使用硬编码默认值 |

---

## 4. 测试命令复现

```bash
curl -s http://127.0.0.1:8889/api/system/config | python3 -m json.tool
curl -s http://127.0.0.1:8889/api/traders | python3 -m json.tool
curl -s "http://127.0.0.1:8889/api/market?symbols=BTC,ETH,SOL" | python3 -m json.tool
```
