#!/bin/bash
# status.sh — 查看 cannbot-gateway-proxy 状态（服务 / 凭证 / 最近请求）
#
# 用法: ./status.sh [端口]     # 缺省 8484

set -euo pipefail

LABEL="cn.hicann.cannbot-gateway-proxy"
RUNTIME_DIR="$HOME/.local/share/cannbot-gateway-proxy"
# 缺省用安装时记录的端口（install.sh 写入），未安装则退回 8484
DEFAULT_PORT="$(cat "$RUNTIME_DIR/port" 2>/dev/null || echo 8484)"
[[ "$DEFAULT_PORT" =~ ^[0-9]+$ ]] || DEFAULT_PORT=8484
PORT="${1:-$DEFAULT_PORT}"

# launchd 原始信息（可能为空 = 未安装）
LAUNCH_INFO="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null || true)"
# healthz 原始 JSON（可能为空 = 服务无响应）
HEALTH_JSON="$(curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"

LOG_FILE="$RUNTIME_DIR/proxy.log"
ERR_LOG="$RUNTIME_DIR/logs/proxy.err.log"

python3 - "$PORT" "$LAUNCH_INFO" "$HEALTH_JSON" "$LOG_FILE" "$ERR_LOG" <<'PYEOF'
import sys, json, re, datetime, os

port, launch_info, health_raw, log_file, err_log = sys.argv[1:6]
color = sys.stdout.isatty()
C = lambda code: f"\033[{code}m" if color else ""
GREEN, RED, YELLOW, DIM, BOLD, RESET = C("32"), C("31"), C("33"), C("2"), C("1"), C("0")

W = 46
print(f"{BOLD}CANNBot 网关代理{RESET}  " + DIM + "─" * W + RESET)

# ---- 服务 ----
pid = None
m = re.search(r"^\s*pid = (\d+)", launch_info, re.M)
if m:
    pid = m.group(1)
if pid:
    svc = f"{GREEN}● 运行中{RESET} (pid {pid})"
elif launch_info:
    svc = f"{YELLOW}● 已安装但未运行{RESET}"
else:
    svc = f"{RED}● 未安装{RESET}  {DIM}启用: ./install.sh{RESET}"
print(f"  服务    {svc}")

if not health_raw:
    print(f"  接口    {RED}http://127.0.0.1:{port} 无响应{RESET}")
    if os.path.exists(err_log):
        tail = [l for l in open(err_log, encoding="utf-8", errors="replace").read().splitlines()[-3:]]
        for l in tail:
            print(f"          {RED}{l[:100]}{RESET}")
    print(f"{RED}✗ 服务不可用{RESET}")
    sys.exit(1)

h = json.loads(health_raw)
print(f"  接口    http://127.0.0.1:{port}/v1  {DIM}→ cannbot.hicann.cn{RESET}")
up = h.get("uptimeSec", 0)
up_h = f"{up//3600}小时{up%3600//60}分" if up >= 3600 else (f"{up//60}分{up%60}秒" if up >= 60 else f"{up}秒")
print(f"  运行    {DIM}已运行 {up_h}{RESET}")

# ---- 凭证 ----
jwt = h.get("jwt", {})
if jwt.get("ok"):
    exp = datetime.datetime.fromisoformat(jwt["expiresAt"].replace("Z", "+00:00")).astimezone()
    remain = exp - datetime.datetime.now().astimezone()
    mins = int(remain.total_seconds() // 60)
    left = f"剩余 {mins//60} 小时 {mins%60} 分" if mins >= 60 else f"仅剩 {mins} 分"
    mark = GREEN if mins > 60 else YELLOW
    print(f"  凭证    {mark}● JWT 有效{RESET}，{exp:%m-%d %H:%M} 过期（{left}）")
else:
    print(f"  凭证    {RED}✗ JWT 不可用{RESET}")
    err = jwt.get("error") or "未知原因"
    print(f"          {RED}{err}{RESET}")
    print(f"          {YELLOW}→ 处理：打开 VSCode 的 CANNWork 扩展重新登录，无需重启代理{RESET}")

vk = f"{GREEN}已缓存{RESET}" if h.get("vkCached") else f"{YELLOW}未换取{RESET}"
print(f"  VK      {vk}{DIM + ('，' + h['vkCachedAt'][11:16] + ' 换取' if h.get('vkCachedAt') else '')}{RESET}")
models = h.get("modelsKnown")
if models:
    print(f"  模型    {models} 个（curl http://127.0.0.1:{port}/v1/models 查看）")

# ---- 最近请求 ----
print(f"{BOLD}最近请求{RESET}  " + DIM + "─" * W + RESET)
if os.path.exists(log_file):
    lines = open(log_file, encoding="utf-8", errors="replace").read().splitlines()[-6:]
    shown = 0
    for line in reversed(lines):  # 最新在上
        m = re.match(r"^\[(.+?)\] (.*)$", line)
        if not m:
            continue
        ts, rest = m.groups()
        try:
            t = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
        except ValueError:
            t = ts[11:19]
        rm = re.match(r"(\S+) (\S+) model=(\S+) → (\d+) (\d+)ms(.*)", rest)
        if rm:
            method, path, model, status, ms, extra = rm.groups()
            sc = GREEN if status.startswith("2") else RED
            mark = f"{sc}{status}{RESET}"
            dur = f"{int(ms)/1000:.1f}s" if int(ms) >= 1000 else f"{ms}ms"
            print(f"  {DIM}{t}{RESET}  {method} {path}  {model}  → {mark}  {dur}{DIM}{extra}{RESET}")
            shown += 1
        elif rest.startswith("ERROR") or "刷新 VK" in rest:
            print(f"  {DIM}{t}{RESET}  {RED}{rest[:90]}{RESET}")
            shown += 1
    if not shown:
        print(f"  {DIM}（暂无请求）{RESET}")
else:
    print(f"  {DIM}（暂无日志）{RESET}")

ok = bool(h.get("ok"))
print(f"{GREEN}✓ 一切正常{RESET}" if ok else f"{RED}✗ 凭证异常，请求会被拒绝{RESET}")
sys.exit(0 if ok else 1)
PYEOF
