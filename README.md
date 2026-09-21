# CANNBot 本地网关代理（cannbot-gateway-proxy）

把 CANNBot 网关的大模型服务封装成**本地 API**（OpenAI 兼容透传 + Anthropic Messages 协议翻译），供 zcode CLI 及本机任意 agent 调用。
代理每次请求自动注入最新凭证，无需在任何业务配置里保存密钥。

```
OpenAI 客户端    → http://127.0.0.1:8484/v1/chat/completions   （原样透传）
Anthropic 客户端 → http://127.0.0.1:8484/v1/messages            （双向协议翻译）
        │  自动注入 Authorization(Bearer JWT) + x-api-vkey(VK)
        ▼
https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions   (CANNBot 网关)
```

> 2026-09-20 全链路验证通过：OpenAI 流式/非流式、Anthropic 流式/非流式/tool_use/tool_result 闭环、多模型调用、zcode CLI 端到端均成功。

---

## 目录结构

| 文件 | 作用 |
|---|---|
| `server.mjs` | 代理本体（Node ≥18 零依赖；内置网页管理台） |
| `admin.html` | 网页管理台页面（`http://127.0.0.1:8484/`） |
| `打开管理界面.command` | **双击即可**：自动确保代理已启动并在浏览器打开管理台 |
| `plist.template` | launchd 配置模板（`install.sh` 按本机路径生成后装到 `~/Library/LaunchAgents/`） |
| `install.sh` | 启用：安装并启动常驻服务（幂等，可重复执行） |
| `uninstall.sh` | 停用：停止服务并取消开机自启（`--revert-configs` 连 zcode 配置一起回滚） |
| `status.sh` | 终端版状态查看（GUI 的命令行等价物；缺省端口自动读运行时目录记录的 `port`） |
| `cannbot-creds.sh` | 凭证校验与诊断（可选，日常不用跑；产出的 `creds.json` 含实时 JWT+VK，默认写到运行时目录 `~/.local/share/cannbot-gateway-proxy/`，不落项目源目录，可用 `CANNBOT_CREDS_FILE` 改位置） |
| `logs/` | 演练/调试日志 |

**两个目录的关系**：本文件夹是项目源（source of truth）；`install.sh` 会把 `server.mjs` 拷贝到运行时目录
`~/.local/share/cannbot-gateway-proxy/`（日志、VK 缓存也生成在那里），launchd 实际运行的是该副本。
原因是 **macOS 对桌面等目录有 TCC 保护，launchd 后台进程无权直接读取桌面上的文件**。
因此：**改动 `server.mjs` 后需重跑 `./install.sh` 才生效**；`./uninstall.sh` 会自动清理运行时目录。

## 前置条件

1. Node.js ≥ 18（`install.sh` 自动探测；本机为 `~/.hermes/node/bin/node`）
2. VSCode 的 **CANNWork 扩展已登录** CANN 账号 —— 登录后它会写 `~/.local/share/opencode/session.json`（内含 24h 有效的 JWT），这是代理唯一的凭证来源。

## 启用方式

**最简单：双击项目文件夹里的「打开管理界面.command」**——自动启动代理并在浏览器打开管理台。

日常管理都在网页管理台完成（每 3 秒自动刷新）：

- 服务状态、JWT 剩余时间倒计时、VK 缓存、模型列表（点击填入测试）
- **流量统计**：今日 / 近 7 天 / 近 30 天三个区间切换（参考 cc-switch 用量页）——区间汇总卡片（请求/错误/输入输出 tokens/平均耗时）、趋势柱状图（今日按小时、多天按日）、分模型区间汇总表（tokens 为上游报告值；数据持久化在运行时目录 `stats.json`，保留近 30 天，卸载即清零；深链 `/#stats-7`、`/#stats-30` 可直达对应区间）
- 一键**发送测试请求**验证链路；日志实时滚动（错误红色高亮）
- **重启服务 / 停止服务**按钮（停止后双击 .command 或 `./install.sh` 再启）

统计亦可程序化读取：`GET /admin/stats`（返回 today/week/models/hours，另含 `days` 逐日数组——每天 `{date, total, models}`，共近 30 天）。

命令行方式等价可用：

```bash
cd ~/Desktop/cannbot-gateway-proxy
./install.sh            # 默认端口 8484；冲突时: ./install.sh 8485
```

装完即验证：`curl http://127.0.0.1:8484/healthz`。服务特性：
- **开机自启 + 崩溃自动拉起**（launchd RunAtLoad + KeepAlive）
- 端口、模型黑名单可用环境变量覆盖（见下"进阶配置"）

## 停用方式

```bash
./uninstall.sh                  # 停止服务 + 移除开机自启
./uninstall.sh --revert-configs # 同上，并把 zcode 配置回滚到接入前备份
```

> 注意：zcode CLI 的模型配置当前指向 `127.0.0.1:8484`。只停服务不回滚配置的话，zcode 的模型请求会失败（连接拒绝）；要么重新 `./install.sh`，要么用 `--revert-configs` 回滚（回滚后 zcode 回到接入前状态：glm provider 走 bigmodel 按量 key，无余额报 429）。

## 刷新凭证方式（重点：通常无事可做）

| 场景 | 你需要做的 |
|---|---|
| **JWT 过期**（每 24h） | 打开 VSCode 的 CANNWork 扩展**重新登录**即可。代理每次请求都从 `session.json` 现读最新 JWT，登录后无需重启代理、无需改任何配置。过期后代理返回带指引的 502（`jwt_expired`），照做即可。 |
| **VK 失效/更换账号** | 无需操作。代理启动后自动换取 VK 并缓存（`vk-cache.json`）；上游 401 时自动重取并重试一次（403「Model not allowed」是账号权限问题，不重试，直接透传）。 |
| **不确定凭证状态** | `./status.sh` 看 `jwt.expiresAt`（过期时间）与 `ok` 字段；或跑 `./cannbot-creds.sh` 做一次完整校验。 |

## 使用方式（本地 agent 接入）

### OpenAI 兼容客户端（zcode、openai SDK、curl 等）

```
Base URL : http://127.0.0.1:8484/v1
API Key  : 任意非空字符串（本地服务不校验）
模型列表 : GET /v1/models （当前 9 个：glm-5.3 / glm-5.3-flash / deepseek-v4-pro / deepseek-v4-flash /
           claude-opus-4-8 / gpt-5.4 / qwen3.8-max / qwen3.8-flash / kimi-k3；
           注意 kimi-k3 账号实际无调用权限，请求会报 "Model not allowed"）
```

curl 示例：

```bash
curl http://127.0.0.1:8484/v1/chat/completions \
  -H 'content-type: application/json' -H 'authorization: Bearer anything' \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

### Anthropic 协议客户端（claude-code、anthropic SDK 等）

```
Base URL : http://127.0.0.1:8484          （SDK 会自动拼 /v1/messages；多写了 /v1 代理也能容错）
API Key  : x-api-key / ANTHROPIC_AUTH_TOKEN 任意非空字符串
```

curl 示例：

```bash
curl http://127.0.0.1:8484/v1/messages \
  -H 'content-type: application/json' -H 'x-api-key: anything' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"glm-5.3-flash","max_tokens":512,"messages":[{"role":"user","content":"你好"}]}'
```

**claude-code 接入**（`~/.claude/settings.json` 的 `env` 块，本机已按此配置）：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "cannbot-local",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8484",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "glm-5.3-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "glm-5.3-flash",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "model": "opus"
}
```

**⚠️ 模型别名必须映射到实测可用的模型**。截至 2026-09-20，账号真正能调通的只有 6 个：
`glm-5.3`、`glm-5.3-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`qwen3.8-max`、`qwen3.8-flash`；
`claude-opus-4-8`、`gpt-5.4`、`kimi-k3` 虽在网关模型列表里，但实际请求返回 403 "Model not allowed"（账号无权限，与代理无关）。

翻译层支持：`system`（字符串/块数组）、文本与 base64/url 图片、`tools`+`tool_choice`（auto/any/none/tool）、
`tool_use`/`tool_result` 多轮闭环、`stop_sequences`、`temperature`/`top_p`、流式（message_start → content_block_* → message_delta(stop_reason+usage) → message_stop 完整事件序列）；
请求带 `thinking.type=enabled` 时，上游的 reasoning_content 会映射为 thinking 块，否则忽略。

**zcode CLI 已接好**（桌面端个人 provider `glm` 的 baseUrl 已指向代理，`~/.zcode/cli/config.json` 的 `provider.cannbot` 同样指向代理），headless 与 TUI 直接可用，无需再配。

## 状态 / 日志 / 排障

**首选：浏览器打开 `http://127.0.0.1:8484/`**（或双击「打开管理界面.command」），状态、凭证、日志、测试一站搞定。

命令行等价：

```bash
./status.sh                         # 服务状态 + 凭证状态 + 最近请求
tail -f proxy.log                   # 实时请求流水（模型、上游状态码、耗时）——运行时目录下
tail -50 logs/proxy.err.log         # 崩溃/启动失败先看这里（运行时目录下）
```

> `proxy.log` 超过 5MB 自动轮转为 `proxy.log.1`（只保留一份旧日志）；管理台「日志」读内存环形缓冲（最近 1000 行），不再每次全量读盘。

| 现象 | 原因与处理 |
|---|---|
| 请求返回 502 `jwt_expired` / `jwt_missing` | CANNWork 扩展未登录或 JWT 过期 → 重新登录即可 |
| 连接拒绝（ECONNREFUSED） | 代理没在运行 → `./install.sh`；或换过端口，客户端 URL 没跟着改 |
| 上游 403 "Model not allowed" | 账号本身无该模型权限（如 kimi-k3），与代理无关 |
| 端口被占 | `./install.sh 8485` 换端口，客户端 URL 同步改 |
| 改了 `server.mjs` 不生效 | 重跑 `./install.sh`（launchd 跑的是运行时副本，改源文件需重新拷贝） |

### 进阶配置（环境变量，写进 launchd plist 或前台导出均可）

| 变量 | 缺省 | 说明 |
|---|---|---|
| `CANNBOT_PROXY_PORT` | `8484` | 监听端口（`./install.sh <端口>` 一步到位） |
| `CANNBOT_EXCLUDE_MODELS` | 空（不隐藏） | 需要从 `/v1/models` 隐藏的模型，逗号分隔 |
| `CANNBOT_SESSION_FILE` | `~/.local/share/opencode/session.json` | JWT 来源，一般不动 |

## 回滚（完全撤销）

```bash
./uninstall.sh --revert-configs   # 停服务 + 回滚 zcode 两处配置
rm -rf ~/Desktop/cannbot-gateway-proxy
```

涉及并已留备份的配置改动（备份以 `.bak-cannbot` 后缀与原文件同目录）：
1. `~/.zcode/v2/provider_config.json` —— 桌面端个人 provider `glm` 的 baseUrl → 本地代理（**zcode CLI 模型路由的关键**）
2. `~/.zcode/cli/config.json` —— `provider.cannbot` → 本地代理

## 已知注意事项

- ZCode.app 在 UI 里改动 provider 时可能重写 `provider_config.json`，把 `glm` 的 baseUrl 改回 bigmodel。发现 zcode 又报"余额不足"时，先 `./status.sh` 看代理是否正常，再用本目录 `cannbot-creds.sh --sync-zcode` 之外的方法检查：`grep -o '127.0.0.1:8484' ~/.zcode/v2/provider_config.json`（无输出即被改回，重跑改接或参考进度报告）。
- 原理备忘：zcode CLI 0.16.9 忽略配置文件里的 `model.main`，实际用个人 provider 存储里第一个 provider 的第一个模型（`glm/glm-5.3-flash`）——这正是改接 `glm` provider 而不是新增 provider 的原因。
- 详细排查过程与结论见 `~/Desktop/CANNBot网关接入zcode-进度报告.md`。
