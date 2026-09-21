#!/usr/bin/env node
// cannbot-gateway-proxy — 把 CANNBot 网关封装为本地 API（OpenAI 兼容 + Anthropic Messages 翻译）
//
//   OpenAI 客户端   → http://127.0.0.1:<PORT>/v1/chat/completions  （原样透传）
//   Anthropic 客户端 → http://127.0.0.1:<PORT>/v1/messages          （双向协议翻译后转发）
//        ↓
//   https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions
//
// 凭证（每次请求现取，不在任何配置里烘死）:
//   JWT ← ~/.local/share/opencode/session.json .accessToken（CANNWork 扩展登录时刷新，24h 有效）
//   VK  ← GET /cannbot/api/models/personal（用 JWT 换取；账号级，不绑定模型；带磁盘缓存，401 时自动重取）
//
// 运行时文件（proxy.log / vk-cache.json）落在本脚本所在目录，随项目文件夹整体移动。
// 端口: 8484（环境变量 CANNBOT_PROXY_PORT 可覆盖），只绑 127.0.0.1
// 推荐由 launchd 托管（见 install.sh），也可前台直接 `node server.mjs` 运行。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.CANNBOT_PROXY_PORT || 8484);
const HOST = '127.0.0.1';
const GATEWAY = 'https://cannbot.hicann.cn';
const GW_API = `${GATEWAY}/gateway/compatible-mode/v1`;
const SESSION_FILE = process.env.CANNBOT_SESSION_FILE
  || path.join(os.homedir(), '.local/share/opencode/session.json');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VK_CACHE = path.join(SCRIPT_DIR, 'vk-cache.json');
const LOG_FILE = path.join(SCRIPT_DIR, 'proxy.log');
const MODELS_TTL = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024 * 1024;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // proxy.log 超过此大小轮转为 proxy.log.1（保留一份）
// 从 /v1/models 列表隐藏的模型（逗号分隔，可被环境变量覆盖；缺省不隐藏任何模型）
const EXCLUDE_MODELS = new Set((process.env.CANNBOT_EXCLUDE_MODELS ?? '').split(',').filter(Boolean));
const PASSTHROUGH_HEADERS = ['content-type', 'x-request-id', 'openai-processing-ms', 'openai-version', 'x-logid'];

// ---- 日志（内存环形缓冲 + 落盘 + 大小轮转） ------------------------------
// /admin/log 直接读内存 ring，不再每次全量读文件（旧实现每 3s 被管理台轮询全量读盘）。

const LOG_RING_MAX = 1000;
const logRing = [];
let logFileBytes = (() => { try { return fs.statSync(LOG_FILE).size; } catch { return 0; } })();

// 启动时把已有日志尾部装进 ring，管理台刷新后历史不丢
try {
  const existing = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  logRing.push(...existing.slice(-LOG_RING_MAX));
} catch {}

function rotateLogIfNeeded() {
  if (logFileBytes < LOG_MAX_BYTES) return;
  try {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); // 只保留一份旧日志
    logFileBytes = 0;
  } catch {}
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  logRing.push(line);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  try {
    rotateLogIfNeeded(); // 先轮转再写入：触发行落在新文件里
    fs.appendFileSync(LOG_FILE, line + '\n');
    logFileBytes += Buffer.byteLength(line) + 1;
  } catch {}
}

function httpError(status, message, code = 'cannbot_proxy_error') {
  return Object.assign(new Error(message), { status, code });
}

function b64urlJson(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch { return null; }
}

const randHex = (n = 12) => randomBytes(n).toString('hex');

// ---- 凭证管理 ----------------------------------------------------------

function readJwt() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw httpError(502, `未找到 ${SESSION_FILE}：请打开 VSCode 的 CANNWork 扩展并登录 CANN 账号`, 'jwt_missing');
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); }
  catch (e) { throw httpError(502, `session.json 解析失败: ${e.message}`, 'jwt_invalid'); }
  const jwt = raw.accessToken;
  if (!jwt) throw httpError(502, 'session.json 中没有 accessToken：请在 CANNWork 扩展中重新登录', 'jwt_missing');
  const payload = b64urlJson(jwt) || {};
  const expMs = (payload.exp || 0) * 1000;
  if (expMs && Date.now() > expMs - 60_000) {
    throw httpError(502,
      `CANNBot JWT 已于 ${new Date(expMs).toLocaleString('zh-CN')} 过期：请打开 CANNWork 扩展重新登录，然后重试`,
      'jwt_expired');
  }
  return { jwt, userId: payload.userId, expMs };
}

// /cannbot/api/models/personal 一次响应里同时含「模型列表」与「账号级 VK(apiKey)」，
// 合并为一份缓存 personalCache，避免 VK 与模型列表各打一次上游。
let personalCache = null; // { userId, at, vk, models }

function readVkDisk(userId) {
  try {
    const d = JSON.parse(fs.readFileSync(VK_CACHE, 'utf8'));
    if (d.userId === userId && d.vk) return d.vk;
  } catch {}
  return null;
}

function buildModels(items) {
  const seen = new Map();
  for (const m of items) {
    if (!m?.model || seen.has(m.model)) continue;
    seen.set(m.model, {
      id: m.model,
      object: 'model',
      created: 0,
      owned_by: 'cannbot',
      title: m.title || m.model,
      context_length: m.contextLength ?? null,
    });
  }
  return [...seen.values()].filter((m) => !EXCLUDE_MODELS.has(m.id));
}

// needVk=true（凭证路径）时缺 VK 视为错误；needVk=false（仅取模型列表）时容忍无 VK。
async function fetchPersonal(jwt, userId, { needVk = true } = {}) {
  const res = await fetch(`${GATEWAY}/cannbot/api/models/personal`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw httpError(502,
      `拉取模型/凭证失败: HTTP ${res.status}（JWT 可能已失效，请在 CANNWork 扩展重新登录）`,
      needVk ? 'vk_fetch_failed' : 'models_fetch_failed');
  }
  const body = await res.json();
  const items = [...(body?.data?.personalModels ?? []), ...(body?.data?.builtinModels ?? [])];
  const vk = items.map((m) => m.apiKey).find(Boolean) ?? null;
  if (needVk && !vk) throw httpError(502, '模型列表响应中没有 VK(apiKey)', 'vk_missing');
  personalCache = { userId, at: Date.now(), vk, models: buildModels(items) };
  if (vk) {
    try { fs.writeFileSync(VK_CACHE, JSON.stringify({ userId, vk, at: personalCache.at })); } catch {}
  }
  return personalCache;
}

async function getVk(jwt, userId, force = false) {
  if (!force && personalCache && personalCache.userId === userId && personalCache.vk) {
    return personalCache.vk;
  }
  if (!force) {
    const disk = readVkDisk(userId);
    if (disk) {
      // 磁盘 VK 兜底；保留同用户已取到的 models，避免无谓重取
      const models = personalCache?.userId === userId ? personalCache.models : null;
      personalCache = { userId, at: Date.now(), vk: disk, models };
      return disk;
    }
  }
  return (await fetchPersonal(jwt, userId, { needVk: true })).vk;
}

// ---- 网关调用（带 401 自动重取 VK 重试一次） ---------------------------

async function gatewayRequest(pathSuffix, { method = 'POST', headers = {}, body } = {}) {
  const { jwt, userId } = readJwt();
  const h = { authorization: `Bearer ${jwt}`, 'x-api-vkey': await getVk(jwt, userId), ...headers };
  let up = await fetch(`${GW_API}${pathSuffix}`, { method, headers: h, body });
  // 仅 401 视为 VK 失效自动重取重试；403（如 "Model not allowed"）是账号级权限问题，
  // 重取 VK 无济于事，直接透传给客户端。
  if (up.status === 401) {
    log(`401 → 刷新 VK 重试 ${method} ${pathSuffix}`);
    h['x-api-vkey'] = await getVk(jwt, userId, true);
    up = await fetch(`${GW_API}${pathSuffix}`, { method, headers: h, body });
  }
  return up;
}

// ---- 模型列表 ----------------------------------------------------------

async function getModels() {
  const { jwt, userId } = readJwt();
  if (personalCache && personalCache.userId === userId
      && personalCache.models && Date.now() - personalCache.at < MODELS_TTL) {
    return personalCache.models;
  }
  const c = await fetchPersonal(jwt, userId, { needVk: false });
  return c.models;
}

// ---- OpenAI 透传 -------------------------------------------------------

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, `请求体超过 ${MAX_BODY / 1024 / 1024}MB 上限`, 'body_too_large');
    chunks.push(chunk); // 先判超限再入内存，峰值不超过 MAX_BODY
  }
  return Buffer.concat(chunks);
}

function extractModel(bodyBuf) {
  try { return JSON.parse(bodyBuf.toString('utf8')).model ?? null; } catch { return null; }
}

async function forward(req, res, urlPath, bodyBuf) {
  const t0 = Date.now();
  const upstreamPath = urlPath.replace(/^\/v1/, '') || '/';
  const headers = { 'content-type': req.headers['content-type'] ?? 'application/json' };
  if (req.headers.accept) headers.accept = req.headers.accept;
  const up = await gatewayRequest(upstreamPath, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf,
  });
  const respHeaders = {};
  for (const h of PASSTHROUGH_HEADERS) {
    const v = up.headers.get(h);
    if (v) respHeaders[h] = v;
  }
  res.writeHead(up.status, respHeaders);

  // 流量统计：透传的同时旁路采集字节数与 usage
  const st = {
    model: extractModel(bodyBuf) ?? '-',
    status: up.status, ms: 0,
    bytesIn: bodyBuf?.length ?? 0, bytesOut: 0, tin: 0, tout: 0,
  };
  let recorded = false;
  const finishStats = () => {
    if (recorded) return;
    recorded = true;
    st.ms = Date.now() - t0;
    recordStats(st);
  };

  if (!up.body) {
    res.end();
    finishStats();
  } else {
    const ct = (up.headers.get('content-type') || '').toLowerCase();
    let tap;
    if (ct.includes('text/event-stream')) {
      // SSE：逐行扫描 data: 帧，抓最后携带的 usage（客户端未要求 include_usage 时没有，计 0）
      let lineBuf = '';
      tap = new Transform({
        transform(chunk, enc, cb) {
          st.bytesOut += chunk.length;
          lineBuf += chunk.toString('utf8');
          let idx;
          while ((idx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, idx).trim();
            lineBuf = lineBuf.slice(idx + 1);
            if (line.startsWith('data:')) {
              try {
                const j = JSON.parse(line.slice(5).trim());
                if (j.usage) {
                  st.tin = j.usage.prompt_tokens ?? st.tin;
                  st.tout = j.usage.completion_tokens ?? st.tout;
                }
              } catch {}
            }
          }
          cb(null, chunk);
        },
        flush(cb) { finishStats(); cb(); },
      });
    } else {
      // JSON：整体收集后解析 usage；超过 4MB 改为从末尾 64KB 窗口正则提取 usage，
      // 避免对超长响应截断后 JSON.parse 静默失败（旧实现丢块后解析必败，usage 计 0）
      const SCAN_MAX = 4 * 1024 * 1024;
      const TAIL_WINDOW = 64 * 1024;
      const chunks = [];
      let collected = 0;
      let overflowed = false;
      let tail = '';
      tap = new Transform({
        transform(chunk, enc, cb) {
          st.bytesOut += chunk.length;
          if (!overflowed) {
            if (collected + chunk.length <= SCAN_MAX) { chunks.push(chunk); collected += chunk.length; }
            else overflowed = true;
          }
          if (overflowed) tail = (tail + chunk.toString('utf8')).slice(-TAIL_WINDOW);
          cb(null, chunk);
        },
        flush(cb) {
          try {
            let usage = null;
            if (!overflowed) {
              usage = JSON.parse(Buffer.concat(chunks).toString('utf8')).usage;
            } else {
              const m = tail.match(/"usage"\s*:\s*(\{[^{}]*\})/);
              if (m) usage = JSON.parse(m[1]);
            }
            if (usage) {
              st.tin = usage.prompt_tokens ?? 0;
              st.tout = usage.completion_tokens ?? 0;
            }
          } catch {}
          finishStats();
          cb();
        },
      });
    }
    tap.on('close', finishStats); // 客户端中途断开也计入
    Readable.fromWeb(up.body).pipe(tap).pipe(res);
  }
  log(`${req.method} ${upstreamPath} model=${st.model} → ${up.status} ${Date.now() - t0}ms`);
}

// ---- Anthropic Messages 协议翻译 ---------------------------------------

function anthropicErrorType(status) {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  if (status === 400) return 'invalid_request_error';
  return 'api_error';
}

function sendAnthropicError(res, status, message) {
  sendJson(res, status, { type: 'error', error: { type: anthropicErrorType(status), message } });
}

// Anthropic 请求体 → OpenAI chat.completions 请求体
function anthropicToOpenAI(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'Anthropic 请求体不是 JSON 对象', 'invalid_request_error');
  if (!body.model) throw httpError(400, 'Anthropic 请求缺少 model 字段', 'invalid_request_error');

  const messages = [];
  if (body.system) {
    const text = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system : [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n');
    if (text) messages.push({ role: 'system', content: text });
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
      continue;
    }
    const parts = [];
    const toolCalls = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && b.source?.type === 'base64') {
        parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` } });
      } else if (b.type === 'image' && b.source?.type === 'url') {
        parts.push({ type: 'image_url', image_url: { url: b.source.url } });
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === 'tool_result') {
        let content;
        if (typeof b.content === 'string') content = b.content;
        else if (Array.isArray(b.content)) {
          content = b.content
            .filter((x) => x?.type === 'text')
            .map((x) => x.text)
            .join('\n');
        } else content = '';
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
      }
      // thinking / redacted_thinking / document 块：OpenAI 侧无对应，忽略
    }
    if (role === 'assistant') {
      const msg = { role: 'assistant' };
      msg.content = parts.length
        ? (parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts)
        : (toolCalls.length ? null : '');
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else if (parts.length) {
      messages.push({
        role: 'user',
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
      });
    }
  }

  const payload = { model: body.model, messages, stream: Boolean(body.stream) };
  if (body.max_tokens != null) payload.max_tokens = body.max_tokens;
  if (body.temperature != null) payload.temperature = body.temperature;
  if (body.top_p != null) payload.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    const tc = body.tool_choice;
    if (tc?.type === 'auto') payload.tool_choice = 'auto';
    else if (tc?.type === 'any') payload.tool_choice = 'required';
    else if (tc?.type === 'none') payload.tool_choice = 'none';
    else if (tc?.type === 'tool' && tc.name) payload.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  if (payload.stream) payload.stream_options = { include_usage: true };

  const thinkingRequested = body.thinking?.type === 'enabled';
  return { payload, thinkingRequested };
}

function mapFinishReason(fr) {
  if (fr === 'tool_calls') return 'tool_use';
  if (fr === 'length') return 'max_tokens';
  if (fr === 'content_filter') return 'end_turn';
  return 'end_turn';
}

function anthropicUsage(u) {
  return {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

// OpenAI 非流式响应 → Anthropic message
function openaiToAnthropicMessage(json, model, thinkingRequested) {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (thinkingRequested && msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: String(msg.reasoning_content) });
  }
  if (msg.content) content.push({ type: 'text', text: String(msg.content) });
  for (const tc of msg.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: tc.id ?? `toolu_${randHex()}`, name: tc.function?.name ?? '', input });
  }
  return {
    id: `msg_${randHex()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: anthropicUsage(json?.usage),
  };
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// OpenAI SSE 流 → Anthropic SSE 流（状态机：thinking 块 → text 块 → tool_use 块）
async function pipeAnthropicStream(res, upBody, model, thinkingRequested, bytesIn = 0) {
  const t0 = Date.now();
  const msgId = `msg_${randHex()}`;
  let messageStarted = false;
  let nextIndex = 0;
  let openBlock = null; // { type, index }
  let usage = null;
  let finishReason = null;

  const startMessage = (inputTokens = 0) => {
    if (messageStarted) return;
    messageStarted = true;
    sseWrite(res, 'message_start', {
      type: 'message_start',
      message: {
        id: msgId, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
  };
  const closeBlock = () => {
    if (openBlock) {
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: openBlock.index });
      openBlock = null;
    }
  };
  const ensureBlock = (type, block) => {
    if (openBlock?.type === type) return openBlock.index;
    closeBlock();
    startMessage();
    const index = nextIndex++;
    sseWrite(res, 'content_block_start', { type: 'content_block_start', index, content_block: block });
    openBlock = { type, index };
    return index;
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const toolStates = new Map(); // OpenAI tool_call.index → Anthropic 块序号
  const handler = (c) => {
    if (c?.usage) usage = c.usage;
    const choice = Array.isArray(c?.choices) ? c.choices[0] : null;
    if (!choice) return;
    const d = choice.delta ?? {};
    startMessage(usage?.prompt_tokens ?? 0);
    if (d.reasoning_content && thinkingRequested) {
      const idx = ensureBlock('thinking', { type: 'thinking', thinking: '' });
      sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: String(d.reasoning_content) } });
    }
    if (d.content) {
      const idx = ensureBlock('text', { type: 'text', text: '' });
      sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: String(d.content) } });
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const key = tc.index ?? 0;
        let st = toolStates.get(key);
        if (!st) {
          const idx = ensureBlock('tool_use', { type: 'tool_use', id: tc.id ?? `toolu_${randHex()}`, name: tc.function?.name ?? '', input: {} });
          st = { index: idx };
          toolStates.set(key, st);
        }
        const frag = tc.function?.arguments;
        if (frag) {
          sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: st.index, delta: { type: 'input_json_delta', partial_json: String(frag) } });
        }
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  // 解析上游 SSE：按帧切分，取 data: 行
  let buffer = '';
  try {
    for await (const chunk of upBody) {
      buffer += Buffer.from(chunk).toString('utf8');
      let sep;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
        for (const line of frame.split(/\r?\n/)) {
          const m = line.match(/^data:\s*(.*)$/);
          if (!m) continue;
          const data = m[1].trim();
          if (!data || data === '[DONE]') continue;
          try { handler(JSON.parse(data)); }
          catch { log(`Anthropic 翻译: 跳过无法解析的 SSE 数据行: ${data.slice(0, 120)}`); }
        }
      }
    }
    // 冲刷残余帧
    for (const line of buffer.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m) continue;
      const data = m[1].trim();
      if (!data || data === '[DONE]') continue;
      try { handler(JSON.parse(data)); } catch {}
    }
  } catch (e) {
    log(`Anthropic 流中断: ${e.message}`);
    recordStats({ model, status: 499, ms: Date.now() - t0, bytesIn, tout: usage?.completion_tokens ?? 0, tin: usage?.prompt_tokens ?? 0 });
    try {
      startMessage();
      closeBlock();
      sseWrite(res, 'error', { type: 'error', error: { type: 'api_error', message: `upstream stream aborted: ${e.message}` } });
    } catch {}
    res.end();
    return;
  }

  try {
    startMessage();
    closeBlock();
    sseWrite(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
      usage: anthropicUsage(usage),
    });
    sseWrite(res, 'message_stop', { type: 'message_stop' });
  } finally {
    recordStats({ model, status: 200, ms: Date.now() - t0, bytesIn, tin: usage?.prompt_tokens ?? 0, tout: usage?.completion_tokens ?? 0 });
    res.end();
  }
}

// /v1/messages 入口：翻译 → 转发 → 翻译回
async function handleAnthropic(req, res, bodyBuf) {
  const t0 = Date.now();
  let body;
  try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); }
  catch (e) { return sendAnthropicError(res, 400, `请求体不是合法 JSON: ${e.message}`); }

  let translated;
  try { translated = anthropicToOpenAI(body); }
  catch (e) { return sendAnthropicError(res, e.status ?? 400, e.message); }

  const { payload, thinkingRequested } = translated;
  const up = await gatewayRequest('/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!up.ok) {
    const text = await up.text().catch(() => '');
    let message = text.slice(0, 2000) || `upstream HTTP ${up.status}`;
    try {
      const e = JSON.parse(text);
      message = e.error?.message || e.message || message;
    } catch {}
    log(`ANTHROPIC /v1/messages model=${payload.model} → ${up.status} ${Date.now() - t0}ms (上游错误)`);
    recordStats({ model: payload.model, status: up.status, ms: Date.now() - t0, bytesIn: bodyBuf.length });
    return sendAnthropicError(res, up.status, message);
  }

  if (payload.stream) {
    await pipeAnthropicStream(res, up.body, payload.model, thinkingRequested, bodyBuf.length);
  } else {
    const json = await up.json();
    const msg = openaiToAnthropicMessage(json, payload.model, thinkingRequested);
    recordStats({
      model: payload.model, status: 200, ms: Date.now() - t0, bytesIn: bodyBuf.length,
      tin: json?.usage?.prompt_tokens ?? 0, tout: json?.usage?.completion_tokens ?? 0,
    });
    sendJson(res, 200, msg);
  }
  log(`ANTHROPIC /v1/messages model=${payload.model} → 200 ${Date.now() - t0}ms${payload.stream ? ' (stream)' : ''}`);
}

// ---- HTTP 服务 ---------------------------------------------------------

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

// DNS-rebinding 防护：状态变更端点要求 Host 为本机回环地址
function isLocalHost(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '';
}

const ADMIN_HTML = path.join(SCRIPT_DIR, 'admin.html');
const LAUNCH_LABEL = 'cn.hicann.cannbot-gateway-proxy';
const LAUNCH_TARGET = `gui/${os.userInfo().uid}/${LAUNCH_LABEL}`;

// ---- 流量统计（内存累计 + 30s 防抖落盘 stats.json） ----------------------

const STATS_FILE = path.join(SCRIPT_DIR, 'stats.json');
const emptyBucket = () => ({ req: 0, err: 0, tin: 0, tout: 0, bin: 0, bout: 0, ms: 0 });

let stats = (() => {
  try {
    const d = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (d && d.days) return d;
  } catch {}
  return { version: 1, days: {} };
})();
let statsDirty = false;

function flushStats() {
  if (!statsDirty) return;
  try {
    const keys = Object.keys(stats.days).sort();
    while (keys.length > 30) delete stats.days[keys.shift()]; // 只保留近 30 天
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
    statsDirty = false;
  } catch (e) { log(`stats.json 写入失败: ${e.message}`); }
}
setInterval(flushStats, 30_000).unref();

const dayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function recordStats({ model = '-', status = 0, ms = 0, bytesIn = 0, bytesOut = 0, tin = 0, tout = 0 }) {
  const now = new Date();
  const day = (stats.days[dayKey(now)] ??= { total: emptyBucket(), models: {}, hours: Array.from({ length: 24 }, () => ({ req: 0, tin: 0, tout: 0 })) });
  const bad = status >= 400;
  for (const b of [day.total, (day.models[model] ??= emptyBucket())]) {
    b.req++;
    if (bad) b.err++;
    b.tin += tin; b.tout += tout; b.bin += bytesIn; b.bout += bytesOut; b.ms += ms;
  }
  const hb = day.hours[now.getHours()];
  hb.req++; hb.tin += tin; hb.tout += tout;
  statsDirty = true;
}

function summarizeStats(keys) {
  const sum = emptyBucket();
  for (const k of keys) {
    const d = stats.days[k];
    if (!d) continue;
    sum.req += d.total.req; sum.err += d.total.err;
    sum.tin += d.total.tin; sum.tout += d.total.tout;
    sum.bin += d.total.bin; sum.bout += d.total.bout; sum.ms += d.total.ms;
  }
  return sum;
}

function launchctl(args) {
  execFile('/bin/launchctl', args, { timeout: 10_000 }, (e) => {
    if (e) log(`launchctl ${args.join(' ')} 失败: ${e.message}`);
  });
}

function tailLog(n = 80) {
  return logRing.slice(-n);
}

const server = http.createServer(async (req, res) => {
  try {
    // 容忍客户端把 Base URL 写成带 /v1 再叠 SDK 自动拼接的情况（/v1/v1/messages → /v1/messages）
    const url = req.url.split('?')[0].replace(/^(\/v1)+(?=\/)/, '/v1');

    if (url === '/healthz') {
      let jwtInfo = { ok: false, error: null };
      try {
        const { userId, expMs } = readJwt();
        jwtInfo = { ok: true, userId, expiresAt: new Date(expMs).toISOString(), expired: false };
      } catch (e) {
        jwtInfo = { ok: false, error: e.message };
      }
      return sendJson(res, 200, {
        ok: jwtInfo.ok,
        service: 'cannbot-gateway-proxy',
        gateway: GW_API,
        protocols: ['openai (passthrough)', 'anthropic messages (translated)'],
        jwt: jwtInfo,
        vkCached: Boolean(personalCache?.vk),
        vkCachedAt: personalCache?.vk ? new Date(personalCache.at).toISOString() : null,
        modelsKnown: personalCache?.models ? personalCache.models.length : null,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (url === '/' || url === '/admin') {
      try {
        const html = fs.readFileSync(ADMIN_HTML);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        return sendJson(res, 404, { error: { message: 'admin.html 缺失：重跑 ./install.sh 安装', type: 'not_found' } });
      }
    }

    if (url === '/admin/log') {
      return sendJson(res, 200, { lines: tailLog(80) });
    }

    // 状态变更端点（重启/停止）只接受 POST：避免 <img>/链接/预取等 GET 误触发
    if (url === '/admin/restart' || url === '/admin/stop') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: { message: '此端点仅接受 POST', type: 'method_not_allowed' } });
      }
      if (!isLocalHost(req)) {
        return sendJson(res, 403, { error: { message: '仅允许通过 127.0.0.1/localhost 访问此端点', type: 'forbidden' } });
      }
      const stopping = url === '/admin/stop';
      sendJson(res, 200, {
        ok: true,
        message: stopping ? '服务停止中' : '服务重启中，几秒后自动恢复',
      });
      const args = stopping
        ? ['bootout', LAUNCH_TARGET]
        : ['kickstart', '-k', LAUNCH_TARGET];
      return setTimeout(() => launchctl(args), 300).unref();
    }

    if (url === '/admin/stats') {
      const today = stats.days[dayKey()] ?? { total: emptyBucket(), models: {}, hours: [] };
      const weekKeys = Object.keys(stats.days).sort().slice(-7);
      const models = Object.entries(today.models)
        .map(([id, b]) => ({ id, ...b }))
        .sort((a, b) => b.req - a.req);
      // 完整逐日数据（含每天的分模型用量），供管理台做今日/近7天/近30天区间汇总与每日趋势图
      const days = Object.keys(stats.days).sort()
        .map((date) => ({ date, total: stats.days[date].total, models: stats.days[date].models }));
      return sendJson(res, 200, {
        today: today.total,
        week: summarizeStats(weekKeys),
        models,
        hours: today.hours,
        days,
        since: weekKeys[0] ?? null,
      });
    }

    if (url === '/v1/models') {
      const list = await getModels();
      return sendJson(res, 200, { object: 'list', data: list });
    }

    if (url === '/v1/messages' || url === '/messages') {
      const bodyBuf = await readRequestBody(req);
      return await handleAnthropic(req, res, bodyBuf);
    }

    if (url.startsWith('/v1/')) {
      const bodyBuf = await readRequestBody(req);
      return await forward(req, res, url, bodyBuf);
    }

    return sendJson(res, 404, {
      error: { message: `未知路径 ${url}；可用: / (管理台), /v1/chat/completions, /v1/messages, /v1/models, /healthz`, type: 'not_found' },
    });
  } catch (e) {
    const status = e.status ?? 500;
    log(`ERROR ${req.method} ${req.url} → ${status}: ${e.message}`);
    if (!res.headersSent) {
      sendJson(res, status, { error: { message: e.message, type: e.code ?? 'internal_error' } });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  log(`cannbot-gateway-proxy 就绪: http://${HOST}:${PORT}/v1 → ${GW_API}（含 Anthropic /v1/messages 翻译）`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log(`收到 ${sig}，退出`); flushStats(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
