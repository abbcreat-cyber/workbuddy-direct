#!/usr/bin/env node
/**
 * ============================================================
 *  wb-direct v2 —— WorkBuddy 模型直连代理（零依赖，单文件）
 * ============================================================
 *
 *  直接用 ck_ API Key 调用 https://copilot.tencent.com/v2/chat/completions，
 *  不启动 CLI、不跑 agent、不带工具定义。
 *
 *  对外提供两种协议：
 *    POST /v1/chat/completions   OpenAI Chat Completions（Codex 之外的客户端用）
 *    POST /v1/responses          OpenAI Responses API（Codex 用，wire_api = "responses"）
 *    GET  /v1/models
 *    GET  /health
 *
 *  v2 相比 v1 新增：/responses 端点。
 *    旧桥接层是「把对话拍平成一坨文本、让模型扮演 assistant」，
 *    这里改为**把 Responses 的 input 直接映射成原生 messages**，角色不丢、不混淆。
 *
 *  上游限制（实测）：
 *    1. 上游【拒绝非流式】→ 对上游恒定用 stream，非流式在本地聚合
 *    2. 拿不到模型列表（/v3/config 返回 models:null）→ 模型清单硬编码
 *
 *  反风控：全局串行 + 最小间隔 + 抖动 + 指数退避；默认不发 User-Agent。
 *
 *  环境变量见 README.md
 * ============================================================
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// ---------------------------------------------------------------- 配置

const UPSTREAM = process.env.WB_UPSTREAM || 'https://copilot.tencent.com/v2/chat/completions';
const PORT = Number(process.env.WB_DIRECT_PORT || 3090);
const HOST = process.env.WB_DIRECT_HOST || '127.0.0.1';
const MIN_INTERVAL_MS = Number(process.env.WB_MIN_INTERVAL_MS || 1200);
const MAX_RETRIES = Number(process.env.WB_MAX_RETRIES || 3);
const LOCAL_KEY = process.env.WB_DIRECT_KEY || '';
const TIMEOUT_MS = Number(process.env.WB_TIMEOUT_MS || 600000);
// ---------------------------------------------------------------- API Key 查找
// 按顺序尝试，先命中先用：
//   1. 环境变量 CODEBUDDY_API_KEY
//   2. 环境变量 WB_KEY_FILE 指向的文件
//   3. 脚本同目录的 wb-api-key.txt
//   4. 脚本同目录的 .env
//   5. 用户主目录的 .wb-api-key
// 文件里可以是裸 Key，也可以是 `CODEBUDDY_API_KEY=xxx` 形式（兼容 .env 写法）。
const KEY_CANDIDATES = [
  process.env.WB_KEY_FILE,
  path.join(__dirname, 'wb-api-key.txt'),
  path.join(__dirname, '.env'),
  path.join(os.homedir(), '.wb-api-key'),
].filter(Boolean);

// 来源 acc-product-config-v3.json（48 项），已剔除图像/视频/补全类
const MODELS = [
  ['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash'],
  ['deepseek-v4-pro', 'Deepseek-V4-Pro'],
  ['deepseek-v4-flash', 'Deepseek-V4-Flash'],
  ['deepseek-v3-2-volc', 'DeepSeek-V3.2'],
  ['deepseek-v3-1-volc', 'DeepSeek-V3.1-Terminus'],
  ['deepseek-v3-1', 'DeepSeek-V3.1'],
  ['glm-5.2', 'GLM-5.2'],
  ['glm-5.1', 'GLM-5.1'],
  ['glm-5.0', 'GLM-5.0'],
  ['glm-5.0-turbo', 'GLM-5.0-Turbo'],
  ['glm-4.7', 'GLM-4.7'],
  ['glm-4.6', 'GLM-4.6'],
  ['kimi-k3-1', 'Kimi-K3'],
  ['kimi-k2.7', 'Kimi-K2.7-Code'],
  ['kimi-k2.6', 'Kimi-K2.6'],
  ['kimi-k2.5', 'Kimi-K2.5'],
  ['kimi-k2-thinking', 'Kimi-K2-Thinking'],
  ['minimax-m3', 'MiniMax-M3'],
  ['minimax-m2.7', 'MiniMax-M2.7'],
  ['minimax-m2.5', 'MiniMax-M2.5'],
  ['hy3', 'Hy3'],
  ['hy3-preview', 'Hy3 preview'],
  ['hunyuan-2.0-thinking', 'Hunyuan-2.0-Thinking'],
  ['hunyuan-chat', 'Hunyuan-Turbos'],
  ['auto', 'Auto'],
].map(([id, name]) => ({ id, name }));

// ---------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => Math.floor(Math.random() * 301);
const hex = (n) => crypto.randomBytes(n).toString('hex');

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

function readKeyFromFile() {
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY.trim();
  for (const f of KEY_CANDIDATES) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const m = /CODEBUDDY_API_KEY\s*=\s*(.+)/.exec(raw);
      const v = (m ? m[1] : raw).trim().replace(/^["']|["']$/g, '');
      if (v) return v;
    } catch (e) {
      /* 换下一个候选 */
    }
  }
  return '';
}

// -------- 本地登录态（桌面端登录后自动写入，有了它就不必申请 API Key）--------
// 文件里 auth.accessToken 是 JWT（实测有效期约 60 天，另有 refreshToken 可续期），
// account.type 表示账号类型（personal / SaaS…），要作为 X-Product 发给上游。
const DESKTOP_AUTH_CANDIDATES = [
  process.env.WB_AUTH_FILE,
  process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
  path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
].filter(Boolean);

function readDesktopAuth() {
  for (const f of DESKTOP_AUTH_CANDIDATES) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const token = d && d.auth && d.auth.accessToken;
      if (!token) continue;
      const acct = d.account || {};
      return {
        token: String(token),
        uid: acct.uid ? String(acct.uid) : null,
        product: acct.type ? String(acct.type) : 'personal',
        source: 'desktop-auth (' + path.basename(f) + ')',
      };
    } catch (e) {
      /* 换下一个候选 */
    }
  }
  return null;
}

/** 凭据解析：优先 API Key（更独立），其次本地登录态（无需申请 Key） */
function readAuth() {
  const key = readKeyFromFile();
  if (key) return { token: key, uid: null, product: 'SaaS', source: 'api-key' };
  return readDesktopAuth();
}

const AUTH = readAuth();
if (!AUTH) {
  console.error('[wb-direct] 未找到任何可用凭据，任选一种方式提供：');
  console.error('  1) 环境变量  CODEBUDDY_API_KEY=ck_xxxxx');
  console.error(`  2) 文件      ${path.join(__dirname, 'wb-api-key.txt')}`);
  console.error('  3) 环境变量  WB_KEY_FILE=<你的 Key 文件路径>');
  console.error('  4) 或者——在桌面端登录一次，本程序会自动读取本地登录态');
  process.exit(1);
}

// ---------------------------------------------------------------- 限速 + 串行

let _chain = Promise.resolve();
let _lastStart = 0;

function schedule(fn) {
  const run = _chain.then(async () => {
    const wait = _lastStart + MIN_INTERVAL_MS + jitter() - Date.now();
    if (wait > 0) await sleep(wait);
    _lastStart = Date.now();
    return fn();
  });
  _chain = run.then(() => undefined, () => undefined);
  return run;
}

function upstreamHeaders() {
  const h = {
    Authorization: `Bearer ${AUTH.token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-Request-ID': hex(16),
    'X-Trace-ID': hex(16),
  };
  // X-Product 必须与账号类型一致（Api Key 场景用 SaaS）；用错虽多半也能通，但不稳。
  if (AUTH.product) h['X-Product'] = AUTH.product;
  // 登录态需要带上用户标识
  if (AUTH.uid) h['X-User-Id'] = AUTH.uid;
  if (process.env.WB_USER_AGENT) h['User-Agent'] = process.env.WB_USER_AGENT;
  return h;
}

class UpstreamError extends Error {
  constructor(status, body) {
    super(`上游 HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
  }
}

async function callUpstream(body) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(UPSTREAM, {
        method: 'POST',
        headers: upstreamHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      lastErr = e;
      if (attempt >= MAX_RETRIES) break;
      const backoff = Math.min(30000, 1000 * 2 ** attempt) + jitter();
      log(`网络异常，${(backoff / 1000).toFixed(1)}s 后重试 (${attempt + 1}/${MAX_RETRIES}): ${e.message}`);
      await sleep(backoff);
      continue;
    }
    if (res.ok) return res;

    const txt = await res.text().catch(() => '');
    lastErr = new UpstreamError(res.status, txt);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const backoff = Math.min(30000, 1000 * 2 ** attempt) + jitter();
      log(`上游 ${res.status}，${(backoff / 1000).toFixed(1)}s 后重试 (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoff);
      continue;
    }
    throw lastErr;
  }
  throw lastErr || new Error('上游请求失败');
}

/** 调上游并把每个 delta 归一化成事件；两种协议共用 */
async function* runUpstream(upBody) {
  const upstream = await schedule(() => callUpstream(upBody));
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      if (!payload) continue;
      let j;
      try {
        j = JSON.parse(payload);
      } catch (e) {
        continue;
      }
      if (j.usage) yield { usage: j.usage };
      const ch = (j.choices || [])[0];
      if (!ch) continue;
      if (ch.finish_reason) yield { finish_reason: ch.finish_reason };
      const d = ch.delta;
      if (!d) continue;
      if (d.content) yield { content: d.content };
      if (d.reasoning_content) yield { reasoning_content: d.reasoning_content };
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) yield { tool_calls: d.tool_calls };
    }
  }
}

/** 把上游 usage 归一成各协议格式 */
function usageForChat(u) {
  return u || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}
function usageForResponses(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || 0,
    input_tokens_details: { cached_tokens: u.prompt_cache_hit_tokens || 0 },
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

/** 累加流式 tool_calls 分片（按 index 合并） */
function mergeToolCall(acc, tc) {
  const i = tc.index ?? 0;
  acc[i] = acc[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
  if (tc.id) acc[i].id = tc.id;
  if (tc.function?.name) acc[i].function.name += tc.function.name;
  if (tc.function?.arguments) acc[i].function.arguments += tc.function.arguments;
}

// ================================================================
//  协议一：Chat Completions
// ================================================================

/**
 * ★ 上游对 messages[].role 做白名单校验：role = "developer"
 *   （OpenAI 新规范里 system 的别名，Codex / Cursor 等新一代客户端用它承载 system 级指令）
 *   会直接被拒：
 *     HTTP 400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 *               "displayMsg":{"zh":"请求被安全策略拦截..."}}
 *   该文案里的 "security policy" 具有误导性，与请求内容无关 —— 仅 role 字段值不在白名单内。
 *   这里统一归一化为 system。
 *   来源：Sliverkiss/workbuddy2api issue #25 的根因分析（2026-09-10）。
 */
function normalizeRoles(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  for (const m of messages) {
    if (m && typeof m === 'object' && typeof m.role === 'string' && m.role.toLowerCase() === 'developer') {
      out.push({ ...m, role: 'system' });
    } else {
      out.push(m);
    }
  }
  return out;
}

function buildUpstreamBody(body) {
  if (!body || typeof body !== 'object') throw new Error('请求体必须是 JSON 对象');
  if (!body.model) throw new Error('缺少 model');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('缺少 messages');
  const out = { model: body.model, messages: normalizeRoles(body.messages), stream: true };
  for (const k of ['temperature', 'top_p', 'max_tokens', 'tools', 'tool_choice', 'reasoning_effort']) {
    if (body[k] !== undefined && body[k] !== null) out[k] = body[k];
  }
  return out;
}

function chatChunk(model, id, delta, finish = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  };
}

async function handleChat(req, res, body) {
  let upBody;
  try {
    upBody = buildUpstreamBody(body);
  } catch (e) {
    return json(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
  }

  const wantStream = body.stream === true;
  const t0 = Date.now();
  const id = `chatcmpl-${hex(12)}`;
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

  let usage = null;
  let fullText = '';
  let fullReasoning = '';
  let finishReason = 'stop';
  const toolAcc = [];
  let ttft = null;

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    send(chatChunk(body.model, id, { role: 'assistant', content: '' }));
  }

  try {
    for await (const ev of runUpstream(upBody)) {
      if (ev.usage) usage = ev.usage;
      if (ev.finish_reason) finishReason = ev.finish_reason;
      const piece = {};
      if (ev.content) {
        piece.content = ev.content;
        fullText += ev.content;
        if (ttft === null) ttft = Date.now() - t0;
      }
      if (ev.reasoning_content) {
        piece.reasoning_content = ev.reasoning_content;
        fullReasoning += ev.reasoning_content;
      }
      if (ev.tool_calls) {
        piece.tool_calls = ev.tool_calls;
        for (const tc of ev.tool_calls) mergeToolCall(toolAcc, tc);
      }
      if (Object.keys(piece).length && wantStream) send(chatChunk(body.model, id, piece));
    }
  } catch (e) {
    const status = e instanceof UpstreamError ? e.status : 502;
    log(`❌ ${body.model} 失败: ${e.message}`);
    if (wantStream) {
      send({ error: { message: e.message, type: 'upstream_error' } });
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      json(res, status, { error: { message: e.message, type: 'upstream_error' } });
    }
    return;
  }

  const cleanTools = toolAcc.filter(Boolean);
  if (cleanTools.length) finishReason = 'tool_calls';

  const stat = `ttft=${ttft || '-'}ms 总=${Date.now() - t0}ms 出=${usage?.completion_tokens ?? '?'}tok credit=${usage?.credit ?? '?'}`;

  if (wantStream) {
    if (cleanTools.length) sentToolsChat(send, body.model, id, cleanTools);
    const last = chatChunk(body.model, id, {}, finishReason);
    if (usage) last.usage = usage;
    send(last);
    res.write('data: [DONE]\n\n');
    res.end();
    log(`✅ chat/stream ${body.model} ${stat}`);
    return;
  }

  const message = { role: 'assistant', content: fullText };
  if (fullReasoning) message.reasoning_content = fullReasoning;
  if (cleanTools.length) {
    message.tool_calls = cleanTools.map((t, i) => ({ ...t, index: i }));
    message.content = fullText || null;
  }
  json(res, 200, {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: usageForChat(usage),
  });
  log(`✅ chat/json   ${body.model} ${stat}`);
}

function sentToolsChat(send, model, id, tools) {
  send(chatChunk(model, id, { tool_calls: tools.map((t, i) => ({ ...t, index: i })) }));
}

// ================================================================
//  协议二：Responses API（Codex）
// ================================================================

/** Responses 的 tools → Chat Completions 的 tools */
function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function' && t.name) {
      out.push({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
      });
    } else if (t.function) {
      out.push(t);
    }
  }
  return out.length ? out : undefined;
}

/**
 * ★ 核心：把 Responses 的 input 直接映射成原生 messages
 *    （不是拍平成一段文本 —— 那样会丢角色、让模型混淆）
 */
function responsesToMessages(body) {
  const messages = [];
  const instr = body.instructions;
  if (typeof instr === 'string' && instr.trim()) messages.push({ role: 'system', content: instr });

  let input = body.input;
  if (typeof input === 'string') input = [{ type: 'message', role: 'user', content: input }];
  if (!Array.isArray(input)) input = [];

  for (const it of input) {
    if (!it || typeof it !== 'object') continue;
    const type = it.type || 'message';

    if (type === 'message' || it.role) {
      const role = it.role || 'user';
      const c = it.content;
      if (typeof c === 'string') {
        messages.push({ role, content: c });
      } else if (Array.isArray(c)) {
        const parts = [];
        for (const p of c) {
          if (!p || typeof p !== 'object') continue;
          if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
            parts.push({ type: 'text', text: p.text || '' });
          } else if (p.type === 'input_image' || p.type === 'image_url') {
            const u = p.image_url || p.url || p.image;
            const s = typeof u === 'string' ? u : u && u.url;
            if (s) parts.push({ type: 'image_url', image_url: { url: s } });
          }
        }
        const hasImage = parts.some((p) => p.type === 'image_url');
        messages.push({ role, content: hasImage ? parts : parts.map((p) => p.text || '').join('') });
      }
    } else if (type === 'function_call') {
      const toolCall = {
        id: it.call_id || it.id,
        type: 'function',
        function: { name: it.name || '', arguments: it.arguments || '{}' },
      };
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) last.tool_calls.push(toolCall);
      else messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
    } else if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: it.call_id || it.id,
        content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? ''),
      });
    }
    // type === 'reasoning' → 别的供应商的加密推理内容，跳过
  }
  return messages;
}

function buildRunBody(body) {
  const messages = responsesToMessages(body);
  if (!messages.length) throw new Error('input/instructions 为空，无法构造请求');
  const out = { model: body.model, messages: normalizeRoles(messages), stream: true };
  const tools = convertTools(body.tools);
  if (tools) out.tools = tools;
  if (body.tool_choice) out.tool_choice = typeof body.tool_choice === 'string' ? body.tool_choice : 'auto';
  for (const k of ['temperature', 'top_p', 'max_tokens', 'reasoning_effort']) {
    if (body[k] !== undefined && body[k] !== null) out[k] = body[k];
  }
  if (body.reasoning && body.reasoning.effort) out.reasoning_effort = body.reasoning.effort;
  return out;
}

/** Responses API 的 SSE 事件流 */
function responsesEmitter(res, model) {
  const rid = 'resp_' + hex(8);
  const mid = 'msg_' + hex(6);
  const fcBase = 'fc_' + hex(6);
  const created = Math.floor(Date.now() / 1000);
  let seq = 0;
  let textIdx = null;
  let text = '';
  const fcItems = [];
  const send = (o) => res.write('data: ' + JSON.stringify({ ...o, sequence_number: seq++ }) + '\n\n');

  send({
    type: 'response.created',
    response: { id: rid, object: 'response', created_at: created, status: 'in_progress', model, output: [] },
  });

  return {
    /** 文本增量 */
    delta(chunk) {
      if (textIdx === null) {
        textIdx = 0;
        send({
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: mid, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        });
        send({ type: 'response.content_part.added', item_id: mid, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      text += chunk;
      send({ type: 'response.output_text.delta', item_id: mid, output_index: 0, content_index: 0, delta: chunk });
    },
    /** 收尾：输出完整事件序列 */
    finish(toolCalls, usage, finishReason) {
      const output = [];
      let nextIndex = 0;

      if (textIdx !== null || text) {
        send({ type: 'response.output_text.done', item_id: mid, output_index: 0, content_index: 0, text });
        send({ type: 'response.content_part.done', item_id: mid, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
        send({
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: mid, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
        });
        output.push({ id: mid, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
        nextIndex = 1;
      }

      (toolCalls || []).forEach((tc, i) => {
        const idx = nextIndex + i;
        const fcid = `${fcBase}${i}`;
        const args = tc.function?.arguments || '{}';
        const name = tc.function?.name || '';
        send({
          type: 'response.output_item.added',
          output_index: idx,
          item: { id: fcid, type: 'function_call', call_id: tc.id, name, arguments: '', status: 'in_progress' },
        });
        send({ type: 'response.function_call_arguments.delta', item_id: fcid, output_index: idx, delta: args });
        send({ type: 'response.function_call_arguments.done', item_id: fcid, output_index: idx, arguments: args });
        send({
          type: 'response.output_item.done',
          output_index: idx,
          item: { id: fcid, type: 'function_call', call_id: tc.id, name, arguments: args, status: 'completed' },
        });
        output.push({ id: fcid, type: 'function_call', call_id: tc.id, name, arguments: args, status: 'completed' });
        fcItems.push({ name, args });
      });

      const finalStatus = finishReason === 'length' ? 'incomplete' : 'completed';
      send({
        type: 'response.completed',
        response: {
          id: rid,
          object: 'response',
          created_at: created,
          status: finalStatus,
          model,
          output,
          usage: usageForResponses(usage),
        },
      });
      res.write('data: [DONE]\n\n');
      res.end();
    },
  };
}

async function handleResponses(req, res, body) {
  let upBody;
  try {
    upBody = buildRunBody(body);
  } catch (e) {
    return json(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
  }

  const t0 = Date.now();
  const toolAcc = [];
  let usage = null;
  let finishReason = 'stop';
  let ttft = null;

  // 一次性拿到全部结果再输出（Responses 客户端多为聚合消费）
  let fullText = '';
  try {
    for await (const ev of runUpstream(upBody)) {
      if (ev.usage) usage = ev.usage;
      if (ev.finish_reason) finishReason = ev.finish_reason;
      if (ev.content) {
        fullText += ev.content;
        if (ttft === null) ttft = Date.now() - t0;
      }
      if (ev.tool_calls) {
        for (const tc of ev.tool_calls) mergeToolCall(toolAcc, tc);
      }
    }
  } catch (e) {
    const status = e instanceof UpstreamError ? e.status : 502;
    log(`❌ responses ${body.model} 失败: ${e.message}`);
    return json(res, status, { error: { message: e.message, type: 'upstream_error' } });
  }

  const cleanTools = toolAcc.filter(Boolean);
  if (cleanTools.length) finishReason = 'tool_calls';

  const wantStream = body.stream !== false;
  if (!wantStream) {
    const output = [];
    if (fullText) {
      output.push({ id: 'msg_' + hex(6), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullText, annotations: [] }] });
    }
    for (const [i, tc] of cleanTools.entries()) {
      output.push({ id: `fc_${hex(6)}${i}`, type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: 'completed' });
    }
    json(res, 200, {
      id: 'resp_' + hex(8),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: body.model,
      output,
      usage: usageForResponses(usage),
    });
    log(`✅ resp/json   ${body.model} ttft=${ttft || '-'}ms 总=${Date.now() - t0}ms 出=${usage?.completion_tokens ?? '?'}tok`);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const em = responsesEmitter(res, body.model);
  if (fullText) em.delta(fullText);
  em.finish(cleanTools, usage, finishReason);
  log(`✅ resp/stream ${body.model} ttft=${ttft || '-'}ms 总=${Date.now() - t0}ms 出=${usage?.completion_tokens ?? '?'}tok credit=${usage?.credit ?? '?'} tools=${cleanTools.map((t) => t.function.name).join(',') || '-'}`);
}

// ---------------------------------------------------------------- HTTP 服务

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

function authorized(req) {
  if (!LOCAL_KEY) return true;
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return (m ? m[1] : req.headers['x-api-key']) === LOCAL_KEY;
}

const ROUTES = {
  chat: ['/v1/chat/completions', '/chat/completions'],
  responses: ['/v1/responses', '/responses'],
  models: ['/v1/models', '/models'],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  log(`← ${req.method} ${p}`);

  if (req.method === 'GET' && (p === '/health' || p === '/healthz')) {
    return json(res, 200, {
      status: 'ok',
      upstream: UPSTREAM,
      models: MODELS.length,
      minIntervalMs: MIN_INTERVAL_MS,
      endpoints: ['/v1/chat/completions', '/v1/responses', '/v1/models'],
    });
  }

  if (!authorized(req)) return json(res, 401, { error: { message: 'unauthorized', type: 'invalid_request_error' } });

  if (req.method === 'GET' && ROUTES.models.includes(p)) {
    return json(res, 200, {
      object: 'list',
      data: MODELS.map((m) => ({ id: m.id, object: 'model', created: 1756000000, owned_by: 'workbuddy', name: m.name })),
    });
  }

  const isChat = ROUTES.chat.includes(p);
  const isResp = ROUTES.responses.includes(p);
  if (req.method !== 'POST' || (!isChat && !isResp)) {
    return json(res, 404, { error: { message: `not found: ${p}`, type: 'invalid_request_error' } });
  }

  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 32 * 1024 * 1024) req.destroy();
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (e) {
      return json(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } });
    }
    const fn = isChat ? handleChat : handleResponses;
    fn(req, res, body).catch((e) => {
      log(`❌ 未捕获异常: ${e.message}`);
      try {
        if (!res.headersSent) json(res, 500, { error: { message: e.message, type: 'internal_error' } });
        else res.end();
      } catch (_) {}
    });
  });
});

server.listen(PORT, HOST, () => {
  log(`wb-direct v2 已启动  http://${HOST}:${PORT}`);
  log(`上游: ${UPSTREAM}`);
  log(`凭据: ${AUTH.source}  (${AUTH.token.length} 字符)` + (AUTH.uid ? `  uid=${AUTH.uid.slice(0, 8)}…` : ''));
  log(`模型: ${MODELS.length} 个 | 限速: ${MIN_INTERVAL_MS}ms + 抖动 | 重试: ${MAX_RETRIES}`);
  log(`端点: /v1/chat/completions  /v1/responses  /v1/models  /health`);
  log(`本地鉴权: ${LOCAL_KEY ? '开启' : '关闭（仅监听 127.0.0.1）'}`);
});
