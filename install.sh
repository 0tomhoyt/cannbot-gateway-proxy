#!/bin/bash
# install.sh — 启用 cannbot-gateway-proxy（生成 launchd 配置并立即启动）
#
# 用法: ./install.sh [端口]     # 缺省 8484
# 停用: ./uninstall.sh
#
# 目录设计（重要）:
#   本文件夹（桌面）= 项目源，server.mjs 在这里维护；
#   ~/.local/share/cannbot-gateway-proxy/ = 运行时安装目录，
#   install.sh 会把 server.mjs 拷贝过去供 launchd 运行——
#   因为 macOS 对桌面等目录有 TCC 保护，launchd 后台进程无权直接读取。
#   因此改动 server.mjs 后需重跑 ./install.sh 才生效。

set -euo pipefail

PORT="${1:-8484}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="cn.hicann.cannbot-gateway-proxy"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$LAUNCH_DIR/$LABEL.plist"
RUNTIME_DIR="$HOME/.local/share/cannbot-gateway-proxy"

msg()  { printf '[install] %s\n' "$*"; }
die()  { printf '[install] 错误: %s\n' "$*" >&2; exit 1; }

# 1) 找 node（≥18，需要内置 fetch）
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && [ -x "$HOME/.hermes/node/bin/node" ] && NODE_BIN="$HOME/.hermes/node/bin/node"
[ -n "$NODE_BIN" ] || die "未找到 node，请先安装 Node.js ≥ 18"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node 版本过低（$("$NODE_BIN" --version)），需要 ≥ 18"
msg "node: $NODE_BIN ($("$NODE_BIN" --version))"

# 2) 先停掉旧实例（幂等；放在端口检查前，保证升级时能覆盖运行中的旧版本）
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
sleep 1

# 3) 前置检查：凭证来源与端口
SESSION_FILE="$HOME/.local/share/opencode/session.json"
[ -f "$SESSION_FILE" ] || msg "警告: 暂未找到 $SESSION_FILE，服务可启动但在 CANNWork 登录前请求会返回 502"
if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "端口 $PORT 仍被非本服务进程占用（可传参换端口: ./install.sh 8485；lsof -i :$PORT 查占用者）"
fi

# 4) 拷贝运行时副本 + 由模板生成本机 plist
mkdir -p "$RUNTIME_DIR/logs"
echo "$PORT" > "$RUNTIME_DIR/port"   # 记录实际端口，供 uninstall.sh/status.sh 读取
cp "$PROJECT_DIR/server.mjs" "$RUNTIME_DIR/server.mjs"
if [ -f "$PROJECT_DIR/admin.html" ]; then
  cp "$PROJECT_DIR/admin.html" "$RUNTIME_DIR/admin.html"
fi
sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__RUNTIME_DIR__|$RUNTIME_DIR|g" \
    "$PROJECT_DIR/plist.template" > "$INSTALLED_PLIST"
if [ "$PORT" != "8484" ]; then
  # 非默认端口时注入环境变量
  python3 - "$INSTALLED_PLIST" "$PORT" <<'EOF'
import sys, plistlib
plist, port = sys.argv[1], int(sys.argv[2])
with open(plist, 'rb') as f: d = plistlib.load(f)
d['EnvironmentVariables'] = {'CANNBOT_PROXY_PORT': str(port)}
with open(plist, 'wb') as f: plistlib.dump(d, f)
EOF
fi

# 5) 加载并启动
launchctl bootstrap "gui/$(id -u)" "$INSTALLED_PLIST"
sleep 2

# 6) 健康检查
if curl -fsS -m 10 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  msg "✅ 服务已启动: http://127.0.0.1:$PORT/v1"
  curl -fsS -m 10 "http://127.0.0.1:$PORT/healthz" | python3 -m json.tool
  msg "运行时目录: ${RUNTIME_DIR}（日志在其 logs/ 与 proxy.log）"
  msg "停用: ./uninstall.sh"
else
  die "服务启动后健康检查未通过，请查看 $RUNTIME_DIR/logs/proxy.err.log"
fi
