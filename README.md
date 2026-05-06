# Hermes Auto Trading Bot

基于 AI（大模型）的加密货币自动交易机器人，支持 **Binance 现货** 交易。

---

## 功能特性

- **AI 驱动交易**：MiniMax-M2.7 大模型实时分析市场数据（RSI、K线、成交量），自主决策买入/卖出/观望
- **Binance 现货交易**：安全可靠的现货交易模式，无合约、无杠杆、无清算风险
- **实时 Dashboard**：Web 前端实时显示账户净值、持仓、行情、交易决策
- **多交易员支持**：支持同时运行多个独立交易策略实例
- **动态观察列表**：自动筛选市场热门币种，优先关注高波动机会

---

## 系统要求

- Python 3.10+
- Binance 现货账户 + API Key（须开启「允许现货交易」权限）
- MiniMax API Key（用于 AI 决策）

---

## 安装步骤

### 1. 克隆项目

```bash
git clone https://github.com/JMWL66/openclaw-trading-bot.git
cd openclaw-trading-bot
```

### 2. 创建配置

复制示例配置文件并填入真实密钥：

```bash
cp data/system_config.json.example data/system_config.json
```

编辑 `data/system_config.json`，填入以下内容：

```json
{
  "exchanges": {
    "binance": {
      "api_key": "你的Binance_API_KEY",
      "secret_key": "你的Binance_SECRET_KEY",
      "testnet": false
    }
  },
  "ai_providers": {
    "minimax_default": {
      "base_url": "https://api.minimax.chat/v1",
      "api_key": "你的MiniMax_API_KEY",
      "model": "MiniMax-M2.7"
    }
  }
}
```

### 3. 安装依赖

```bash
pip install requests hmac hashlib
# 如需 OKX 交易，还需：pip install okx
```

### 4. 启动服务

```bash
python3 src/server.py
```

或使用一键脚本：

```bash
chmod +x start.sh
./start.sh
```

### 5. 打开 Dashboard

浏览器访问：**http://127.0.0.1:8888**

---

## 目录结构

```
.
├── src/
│   ├── server.py            # Web 服务端（端口 8888）
│   ├── ai_trader.py         # AI 交易引擎（核心逻辑）
│   ├── binance_client.py    # Binance 现货 API 封装
│   ├── minimax_engine.py     # MiniMax AI 接口
│   ├── okx_client.py        # OKX API 封装（可选）
│   └── exchange_adapter.py  # 交易所适配器
├── public/
│   ├── index.html           # Dashboard 前端页面
│   ├── css/style.css        # 样式
│   └── js/app.js            # 前端 JS 逻辑
├── data/
│   ├── system_config.json   # 配置文件（不提交到 Git）
│   ├── system_config.json.example  # 配置示例
│   └── sessions/            # 交易员会话数据（不提交到 Git）
├── docs/
│   └── SKILL.md             # 交易策略说明
└── start.sh                # 一键启动脚本
```

---

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/traders` | 列出所有交易员 |
| POST | `/api/traders/<id>/start` | 启动交易员 |
| POST | `/api/traders/<id>/stop` | 停止交易员 |
| GET | `/api/balance?trader_id=<id>` | 查询账户余额 |
| GET | `/api/market` | 获取实时行情 |
| GET | `/api/status` | 系统状态 |

---

## 交易参数（AI 决策参考）

- **交易对**：BTC/USDT、ETH/USDT、SOL/USDT + 动态热门币种
- **RSI 阈值**：RSI > 70 超买，RSI < 30 超卖
- **决策周期**：默认 30 秒一轮
- **风险控制**：无杠杆、无止损止盈（现货直接买卖）

---

## ⚠️ 风险提示

1. 本项目仅供学习研究，**不构成投资建议**
2. 加密货币市场波动极大，机器人交易存在亏损风险
3. 请先在 **现货测试账户** 中充分验证，再投入真实资金
4. 定期检查 API 权限，遵循「最小权限原则」

---

## License

MIT License
