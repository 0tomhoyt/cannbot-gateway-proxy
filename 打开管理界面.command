#!/bin/bash
# 打开管理界面.command — 双击即可：确保代理已启动，并在浏览器打开网页管理台
DIR="$(cd "$(dirname "$0")" && pwd)"
# 端口优先级：环境变量 > 安装时记录的端口 > 默认 8484
RECORDED_PORT="$(cat "$HOME/.local/share/cannbot-gateway-proxy/port" 2>/dev/null || true)"
PORT="${CANNBOT_PROXY_PORT:-${RECORDED_PORT:-8484}}"

echo "正在检查 CANNBot 网关代理…"
if curl -fsS -m 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "代理已在运行。"
else
  echo "代理未启动，正在启动（首次会请求终端访问桌面目录的权限，请允许）…"
  "$DIR/install.sh" "$PORT"
fi

echo "打开管理台：http://127.0.0.1:$PORT/"
open "http://127.0.0.1:$PORT/"
sleep 2
