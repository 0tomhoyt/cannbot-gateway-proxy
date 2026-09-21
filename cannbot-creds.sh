#!/bin/bash
# cannbot-creds.sh — 校验/拉取 CANNBot 网关凭证（诊断工具）
#
# 说明：代理（server.mjs）每次请求自行从 session.json 现取 JWT 并注入 VK，
#       正常使用无需运行本脚本。它用于：人工校验凭证是否有效、查看可用模型、
#       （可选）把 ~/.zcode/cli/config.json 的 cannbot provider 重写为指向本地代理。
#
# 用法:
#   ./cannbot-creds.sh                校验凭证并刷新 ./creds.json
#   ./cannbot-creds.sh --sync-zcode   上述操作后，把 ~/.zcode/cli/config.json 的 cannbot provider 指向本地代理
#
# 凭证来源:
#   JWT ← ~/.local/share/opencode/session.json（CANNWork 扩展登录时写入，24h 有效）
#   VK  ← GET /cannbot/api/models/personal（用 JWT 换取，账号级，实测跨模型有效）

set -euo pipefail

SESSION_FILE="$HOME/.local/share/opencode/session.json"
MODELS_API="https://cannbot.hicann.cn/cannbot/api/models/personal"
GATEWAY_BASE="https://cannbot.hicann.cn/gateway/compatible-mode/v1"
# 本地代理常驻地址（launchd: cn.hicann.cannbot-gateway-proxy），
# 自行注入 JWT+VK；zcode 配置一律指向代理，不再烘真实凭证。
PROXY_URL="${CANNBOT_PROXY_URL:-http://127.0.0.1:8484/v1}"
# creds.json 含实时 JWT+VK，默认写到运行时目录（不进桌面源目录/版本库/同步盘）；
# 需要落在别处时：CANNBOT_CREDS_FILE=/path/to/creds.json ./cannbot-creds.sh
CREDS_DIR="${CANNBOT_CREDS_DIR:-$HOME/.local/share/cannbot-gateway-proxy}"
mkdir -p "$CREDS_DIR"
CREDS="${CANNBOT_CREDS_FILE:-$CREDS_DIR/creds.json}"
ZCODE_CONFIG="$HOME/.zcode/cli/config.json"
# 排除的模型 slug（逗号分隔，按需增删；缺省不排除——kimi-k3 虽无权限也照常列出）
EXCLUDE_MODELS=""

msg() { printf '[cannbot] %s\n' "$*"; }
die() { printf '[cannbot] 错误: %s\n' "$*" >&2; exit 1; }

[ -f "$SESSION_FILE" ] || die "未找到 ${SESSION_FILE}（请先打开 CANNWork 扩展并登录）"
JWT=$(jq -r '.accessToken // empty' "$SESSION_FILE")
[ -n "$JWT" ] || die "session.json 中没有 accessToken，请先登录 CANNWork"

RESP=$(curl -fsS -m 20 -H "Authorization: Bearer $JWT" "$MODELS_API") \
  || die "拉取模型列表失败（JWT 可能已过期：打开 CANNWork 重新登录后重试）"

# builtin + personal 合并，slug 去重（personal 优先），剔除不可用模型
MODELS_JSON=$(echo "$RESP" | jq --arg ex "$EXCLUDE_MODELS" '
  ($ex | split(",")) as $ex
  | [.data.personalModels[], .data.builtinModels[]]
  | map(select(.model as $m | ($ex | index($m)) | not))
  | map({slug: .model, title: (.title | sub(" \\(built-in\\)$"; "")), ctx: (.contextLength // 131072)})
  | unique_by(.slug)') || die "解析模型列表失败"

COUNT=$(echo "$MODELS_JSON" | jq 'length')
[ "$COUNT" -gt 0 ] || die "没有可用模型"

# 账号级 VK：取任一可用模型的（网关按账号校验，不绑定具体模型）
VK=$(echo "$RESP" | jq -r '[.data.personalModels[], .data.builtinModels[]][] | select(.apiKey) | .apiKey' | head -1)
[ -n "$VK" ] || die "没有取到 VK"

umask 077
jq -n \
  --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg base "$GATEWAY_BASE" --arg jwt "$JWT" --arg vk "$VK" \
  --argjson models "$MODELS_JSON" \
  '{updatedAt: $now, baseUrl: $base, jwt: $jwt, vk: $vk, models: $models}' > "$CREDS"
msg "凭证有效 → ${CREDS}（${COUNT} 个模型: $(echo "$MODELS_JSON" | jq -r 'map(.slug) | join(", ")')）"

if [ "${1:-}" = "--sync-zcode" ]; then
  [ -f "$ZCODE_CONFIG" ] || die "未找到 $ZCODE_CONFIG"
  cp "$ZCODE_CONFIG" "$ZCODE_CONFIG.bak-cannbot"
  ZCODE_MODELS=$(echo "$MODELS_JSON" | jq 'map({key: .slug, value: {name: .title}}) | from_entries')
  TMP=$(mktemp)
  # 只替换 provider.cannbot 条目（指向本地代理，代理负责注入凭证），其余键一概不动
  jq --arg base "$PROXY_URL" --argjson zm "$ZCODE_MODELS" '
    .provider = (.provider // {}) |
    .provider.cannbot = {
      kind: "openai-compatible",
      name: "CANNBot Gateway (via local proxy)",
      options: {
        apiKeyRequired: false,
        baseURL: $base,
        apiKey: "cannbot-local"
      },
      models: $zm
    }' "$ZCODE_CONFIG" > "$TMP" || { rm -f "$TMP"; cp "$ZCODE_CONFIG.bak-cannbot" "$ZCODE_CONFIG"; die "生成配置失败，已回滚"; }
  jq -e . "$TMP" > /dev/null \
    || { rm -f "$TMP"; cp "$ZCODE_CONFIG.bak-cannbot" "$ZCODE_CONFIG"; die "生成的配置未通过 JSON 校验，已回滚"; }
  mv "$TMP" "$ZCODE_CONFIG"
  chmod 600 "$ZCODE_CONFIG"
  msg "zcode 配置已同步: provider.cannbot → ${PROXY_URL}，其余条目未动（备份: $ZCODE_CONFIG.bak-cannbot）"
fi
