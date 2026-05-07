# Hermes AI Trading Kit v1.3.1-TS

发布日期：2026-05-08

## 修复的问题

### DELETE /api/traders/:id 配置文件未清理
- 原因：saveSystemConfig() 内部 merge 逻辑会重新合并磁盘状态，导致已删除的交易员被恢复
- 修复：DELETE 操作直接 writeFileSync 写入，不走 merge 函数
- 文件：src/server.ts:263

### GET /api/traders 返回嵌套结构
- 原因：前端错误地用 data.traders 取了一层嵌套
- 修复：GET /api/traders 直接返回 traders 数组

### getTraderInfo 缺少配置字段
- 原因：只返回 {pid, status}，缺少 name/ai_provider/exchange 等
- 修复：合并 traderCfg 配置对象与运行时状态

## 已知问题（v1.3.1）
- Python 版（8888 端口）暂不可用，仅 TypeScript 版（8889）可用
- macOS 上 tsx 有进程缓存，需 kill -9 彻底重启

## 安装
git clone https://github.com/taoke100/Hremes_aotu_tradig.git
cd Hremes_aotu_tradig
git checkout v1.3.1-ts
npm install
PORT=8889 node --import tsx src/server.ts
