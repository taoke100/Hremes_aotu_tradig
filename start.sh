#!/bin/bash
# OpenClaw Trading Bot — Binance / OKX 双交易所版 一键启动脚本
set -e

echo "========================================="
echo " OpenClaw Trading Bot 启动中..."
echo "========================================="

# Python 版本检查
PYTHON_CMD=${PYTHON_CMD:-python3}
PY_VERSION=$($PYTHON_CMD -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "0")
if [ "$(echo "$PY_VERSION < 3.9" | bc)" = "1" ]; then
    echo "[错误] 需要 Python 3.9+，当前版本: $PY_VERSION"
    exit 1
fi
echo "[OK] Python $PY_VERSION"

# 安装依赖
echo "[*] 安装依赖..."
$PYTHON_CMD -m pip install --quiet requests flask flask_cors 2>/dev/null || pip install --quiet requests flask flask_cors 2>/dev/null || true
echo "[OK] 依赖就绪"

# 项目根目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 启动服务
echo "[*] 启动 Flask 服务..."
$PYTHON_CMD src/server.py &
SERVER_PID=$!
echo "[OK] 服务已启动 (PID: $SERVER_PID)"

# 自动打开浏览器
sleep 1
if command -v open &>/dev/null; then
    echo "[*] 打开浏览器..."
    open http://127.0.0.1:5000
elif command -v xdg-open &>/dev/null; then
    xdg-open http://127.0.0.1:5000
fi

echo ""
echo "========================================="
echo " 启动完成！"
echo " 访问: http://127.0.0.1:5000"
echo " 停止: kill $SERVER_PID"
echo "========================================="
wait
