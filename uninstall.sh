#!/bin/bash
# uninstall.sh — 停用 cannbot-gateway-proxy
#
# 用法:
#   ./uninstall.sh                 停止服务、移除 launchd 配置与运行时副本（保留 zcode 配置指向）
#   ./uninstall.sh --revert-configs  同上，并把 zcode 相关配置回滚到接入前备份
#
# 回滚涉及的备份文件（--revert-configs 时还原）:
#   ~/.zcode/v2/provider_config.json.bak-cannbot
#   ~/.zcode/cli/config.json.bak-cannbot

set -euo pipefail

LABEL="cn.hicann.cannbot-gateway-proxy"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNTIME_DIR="$HOME/.local/share/cannbot-gateway-proxy"
# 安装时记录的端口（install.sh 写入）；缺失则按默认 8484 检查
PORT="$(cat "$RUNTIME_DIR/port" 2>/dev/null || echo 8484)"
[[ "$PORT" =~ ^[0-9]+$ ]] || PORT=8484

msg() { printf '[uninstall] %s\n' "$*"; }

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && msg "服务已停止" || msg "服务本就未在运行"
rm -f "$INSTALLED_PLIST" && msg "已移除 ${INSTALLED_PLIST}（开机自启一并取消）"
rm -rf "$RUNTIME_DIR" && msg "已清理运行时副本 $RUNTIME_DIR"

sleep 1
if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  msg "警告: $PORT 端口仍被占用，请手动检查: lsof -i :$PORT"
fi

if [ "${1:-}" = "--revert-configs" ]; then
  for pair in \
    "$HOME/.zcode/v2/provider_config.json:$HOME/.zcode/v2/provider_config.json.bak-cannbot" \
    "$HOME/.zcode/cli/config.json:$HOME/.zcode/cli/config.json.bak-cannbot"
  do
    target="${pair%%:*}"; backup="${pair##*:}"
    if [ -f "$backup" ]; then
      cp "$backup" "$target"
      msg "已回滚 $target ← $(basename "$backup")"
    else
      msg "跳过 $target（无备份 $backup）"
    fi
  done
  msg "注意: 回滚后 zcode CLI 回到接入前状态（glm provider → bigmodel 按量 key，无余额会报 429）"
fi

msg "完成。重新启用: ./install.sh"
