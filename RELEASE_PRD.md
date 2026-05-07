# Hermes AI Trading Bot — Release v1.3.1-TS PRD

## 1. 需求概述

### 1.1 项目背景
Hermes 是一个基于 AI 的加密货币永续合约自动交易系统，支持 Binance 和 OKX 两大交易所。

### 1.2 本次发布范围（v1.3.1-TS）
修复两个前端显示 bug，确保交易员能从设置页面正常创建和显示：

| Issue | 描述 | 优先级 |
|-------|------|--------|
| #1 | 交易员列表永远显示空（fetchTradersList 嵌套 .traders 取错层） | P0 |
| #2 | 交易员卡片名字显示 undefined（getTraderInfo 只返回 pid/status） | P0 |

## 2. 技术规格

### 2.1 技术栈
- **后端**：TypeScript + Express（端口 8889）
- **前端**：Vanilla JS（app.js），无框架
- **存储**：JSON 文件（data/system_config.json）
- **交易所**：Binance Futures USDT-M，OKX USDT-M SWAP
- **AI**：MiniMax / DeepSeek / Qwen（多提供商引擎）

### 2.2 关键接口

#### GET /api/traders
返回所有交易员配置 + 运行时状态：
```json
{
  "Ximeng": {
    "name": "西蒙",
    "ai_provider": "minimax_default",
    "exchange": "binance",
    "scan_frequency": 30,
    "initial_balance": null,
    "skill_content": "...",
    "skill_filename": "SKILL_WYCKOFF_RSI_BINANCE_V1.md",
    "pid": 13092,
    "status": "running"
  }
}
```

#### POST /api/traders
创建交易员（multipart/form-data）：
- `id`：交易员 ID（唯一）
- `name`：显示名称
- `ai_provider`：AI 提供商（minimax_default / DeepSeek / qwen_trader1）
- `exchange`：交易所（binance / okx_Ag）
- `scan_frequency`：扫描频率（秒）
- `initial_balance`：初始净值（可选）
- `skill_file`：策略文件（可选）

### 2.3 数据流
1. 页面加载 → fetch GET /api/traders
2. 渲染交易员列表（fetchTradersList 函数）
3. 点击"新建" → 表单提交 POST /api/traders
4. 成功 → fetchTradersList 刷新列表

## 3. 修复详情

### Fix #1：fetchTradersList 嵌套错误
- **文件**：`public/js/app.js` 第 1470 行
- **原代码**：`const traders = data.traders || {}`
- **问题**：GET /api/traders 直接返回 traders 对象，无嵌套
- **修复**：`const traders = await res.json()`

### Fix #2：getTraderInfo 缺少配置字段
- **文件**：`src/server.ts` 第 167 行
- **原代码**：只返回 `{ pid, status }`
- **修复**：`return { ...traderCfg, pid, status }`

## 4. 测试用例

| TC | 步骤 | 预期结果 |
|----|------|---------|
| TC-01 | GET /api/traders | 返回所有交易员，字段完整（name/ai_provider/exchange/freq） |
| TC-02 | 新建交易员表单提交 | 200，返回 { status:"stopped", id:"xxx", pid:0 }，config 写入 |
| TC-03 | 重复 ID 提交 | 409 Conflict |
| TC-04 | 空 ID 提交 | 400 Bad Request |
| TC-05 | 删除交易员 | config 中清除，进程停止 |
| TC-06 | 交易所配置保存 | POST /api/system/config → 200 |
| TC-07 | AI 模型配置保存 | POST /api/system/config → 200 |
| TC-08 | 前端交易员列表显示 | 显示所有交易员，名字/AI/交易所正确 |
| TC-09 | 前端创建交易员 | 刷新列表出现新交易员 |
| TC-10 | 启动交易员 | POST /api/traders/:id/start → pid > 0，状态 running |

## 5. 验收标准

- [ ] TC-01 ~ TC-10 全部通过
- [ ] GitHub CI 构建绿色
- [ ] tag v1.3.1-ts 已推送
- [ ] Release Notes 已生成
- [ ] 无 console error
- [ ] 局域网 http://192.168.10.194:8889 可访问

## 6. 已知限制

- Python 版（8888 端口）当前无响应，仅 TypeScript 版（8889）可用
- tsx 在 macOS 上有进程缓存问题，需 kill -9 彻底重启
- 浏览器需 Cmd+Shift+R 强制刷新加载最新 JS
