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
# 凭证来源（与 server.mjs 同步，对齐 CANNWork 2.0.2+ 链路）:
#   JWT ← ~/.local/share/opencode/session.json（CANNWork 扩展登录时写入，24h 有效）
#   VK  ← ① ~/.local/share/opencode/auth.json .cannbot.key（扩展登录时写入的官方位置）
#         ② GET /cannbot/api/ai-keys/vk/my（JWT 换取，附带配额）
#         ③ GET /cannbot/api/models/personal 各模型 apiKey（遗留兜底）
#   模型 ← GET /cannbot/api/models/list（官方接口，status=1）；失败回落 /models/personal（遗留）

set -euo pipefail

SESSION_FILE="$HOME/.local/share/opencode/session.json"
AUTH_JSON="$HOME/.local/share/opencode/auth.json"
LIST_API="https://cannbot.hicann.cn/cannbot/api/models/list"
VK_API="https://cannbot.hicann.cn/cannbot/api/ai-keys/vk/my"
PERSONAL_API="https://cannbot.hicann.cn/cannbot/api/models/personal"
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
# 排除的模型 slug（逗号分隔，按需增删；缺省不排除）
EXCLUDE_MODELS=""

msg() { printf '[cannbot] %s\n' "$*"; }
die() { printf '[cannbot] 错误: %s\n' "$*" >&2; exit 1; }

[ -f "$SESSION_FILE" ] || die "未找到 ${SESSION_FILE}（请先打开 CANNWork 扩展并登录）"
JWT=$(jq -r '.accessToken // empty' "$SESSION_FILE")
[ -n "$JWT" ] || die "session.json 中没有 accessToken，请先登录 CANNWork"

# ---- 模型列表：官方 /models/list 优先，遗留 /models/personal 兜底 -----------

MODELS_JSON="" MODELS_SRC="" LEGACY_RESP=""

fetch_list() {
  local resp
  resp=$(curl -fsS -m 20 -H "Authorization: Bearer $JWT" "$LIST_API?page=1&size=100" 2>/dev/null) || return 1
  MODELS_JSON=$(echo "$resp" | jq --arg ex "$EXCLUDE_MODELS" '
    ($ex | split(",")) as $ex
    | [.models[]? | select(.status == 1)]
    | map(select(.model as $m | ($ex | index($m)) | not))
    | map({slug: .model, title: (.title | sub(" \\(built-in\\)$"; "")), ctx: (.contextLength // 131072)})
    | unique_by(.slug)') || return 1
  [ "$(echo "$MODELS_JSON" | jq 'length')" -gt 0 ] || return 1
  MODELS_SRC="models/list"
}

fetch_legacy() {
  LEGACY_RESP=$(curl -fsS -m 20 -H "Authorization: Bearer $JWT" "$PERSONAL_API" 2>/dev/null) || return 1
  MODELS_JSON=$(echo "$LEGACY_RESP" | jq --arg ex "$EXCLUDE_MODELS" '
    ($ex | split(",")) as $ex
    | [.data.personalModels[], .data.builtinModels[]]
    | map(select(.model as $m | ($ex | index($m)) | not))
    | map({slug: .model, title: (.title | sub(" \\(built-in\\)$"; "")), ctx: (.contextLength // 131072)})
    | unique_by(.slug)') || return 1
  [ "$(echo "$MODELS_JSON" | jq 'length')" -gt 0 ] || return 1
  MODELS_SRC="models/personal(遗留)"
}

fetch_list || fetch_legacy \
  || die "拉取模型列表失败：/models/list 与 /models/personal 均不可用（JWT 可能已过期：打开 CANNWork 重新登录后重试）"

COUNT=$(echo "$MODELS_JSON" | jq 'length')
[ "$COUNT" -gt 0 ] || die "没有可用模型"

# ---- 账号级 VK：auth.json → ai-keys 接口 → 遗留模型 apiKey -----------------

VK="" VK_SRC="auth.json" VK_RESP=""
if [ -f "$AUTH_JSON" ]; then
  VK=$(jq -r '.cannbot.key // empty' "$AUTH_JSON" 2>/dev/null) || VK=""
fi
if [ -z "$VK" ]; then
  VK_RESP=$(curl -fsS -m 20 -H "Authorization: Bearer $JWT" "$VK_API" 2>/dev/null) || VK_RESP=""
  if [ -n "$VK_RESP" ]; then
    VK=$(echo "$VK_RESP" | jq -r '.data.vk // empty')
    VK_SRC="ai-keys"
  fi
fi
if [ -z "$VK" ] && [ -n "$LEGACY_RESP" ]; then
  VK=$(echo "$LEGACY_RESP" | jq -r '[.data.personalModels[], .data.builtinModels[]][] | select(.apiKey) | .apiKey' | head -1)
  VK_SRC="legacy apiKey"
fi
[ -n "$VK" ] || die "没有取到 VK（auth.json / ai-keys 接口 / 遗留接口均未取到）"

QUOTA_JSON="null"
if [ "$VK_SRC" = "ai-keys" ] && [ -n "$VK_RESP" ]; then
  QUOTA_JSON=$(echo "$VK_RESP" | jq '{dailyQuota: .data.dailyQuota, monthlyQuota: .data.monthlyQuota, priority: .data.priority, modelAllowList: .data.modelAllowList}')
fi

umask 077
jq -n \
  --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg base "$GATEWAY_BASE" --arg jwt "$JWT" --arg vk "$VK" \
  --arg vksrc "$VK_SRC" --arg msrc "$MODELS_SRC" \
  --argjson models "$MODELS_JSON" --argjson quota "$QUOTA_JSON" \
  '{updatedAt: $now, baseUrl: $base, jwt: $jwt, vk: $vk, vkSource: $vksrc, modelsSource: $msrc, models: $models, vkQuota: $quota}' > "$CREDS"
msg "凭证有效 → ${CREDS}（${COUNT} 个模型，来源 ${MODELS_SRC}；VK 来源 ${VK_SRC}: $(echo "$MODELS_JSON" | jq -r 'map(.slug) | join(", ")')）"

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
