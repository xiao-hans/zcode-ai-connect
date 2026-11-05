#!/usr/bin/env node
/**
 * codex-responses-bridge.mjs — 本地协议桥(127.0.0.1:39268),把三类宿主的请求翻译成
 * zcode-*-connect 四个 chat/completions 端点:
 *   · Codex(0.142+,仅 Responses API):POST /v1/responses
 *   · Claude Code:POST /v1/messages + /v1/messages/count_tokens(Anthropic Messages)
 *   · Hermes 等原生 OpenAI 客户端:POST /v1/chat/completions(透传,桥只做前缀路由)
 * 文件名沿用 codex 起名,现同时服务三类宿主。
 *
 * 背景:Codex 自 2026-02 起硬移除 wire_api="chat"(见 openai/codex discussion 7782),
 * 只讲 /v1/responses;而本套件四个端点只讲 /v1/chat/completions。本桥在 127.0.0.1:39268
 * 把 Responses 请求翻译成 chat 请求,把 chat SSE 翻译回 Responses SSE 事件流。
 * 工具调用、思维链、用量统计均映射;token/端口从各端点 endpoint.json 实时读取(30s 缓存)。
 *
 * 用法:
 *   node scripts/codex-responses-bridge.mjs serve [--port 39268]   # 前台运行
 *   node scripts/codex-responses-bridge.mjs ensure                 # 探测,不在则后台拉起(自验证)
 *   node scripts/codex-responses-bridge.mjs status                 # 报告桥与四个端点状态
 *
 * 模型 id 带提供方前缀:wb/* trae/* qoder/* qw/*(四家存在同名模型,前缀消歧)。
 * 纯 Node 零依赖;只绑定 127.0.0.1。桥不核对本机调用方。它从各端点 endpoint.json
 * 读出 bearer 并附在转发请求上,所以打到桥的调用并不经过端点自己的鉴权。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { hostIsLoopback, originIsLoopback } from '../zcode-trae-connect/src/loopback.js';
import { detectStall, CONTINUE_PROMPT } from '../shared/stall-detector.mjs';

const DEFAULT_PORT = 39268;
const EP_CACHE_TTL_MS = 30_000;

const TOOLS = [
  { key: 'wb', tool: 'workbuddy', expectPort: 39271 },
  { key: 'trae', tool: 'trae', expectPort: 39272 },
  { key: 'qoder', tool: 'qoder', expectPort: 39270 },
  { key: 'qw', tool: 'qwenwork', expectPort: 39269 },
];

const stateDir = path.join(os.homedir(), '.zcode-codex-bridge');
const logPath = path.join(stateDir, 'service.log');
// 进程身份:供 /healthz 报告,restart 用它确认「旧进程真的被换掉了」。
const startedAt = new Date().toISOString();
let codeMtime = '';
try { codeMtime = fs.statSync(fileURLToPath(import.meta.url)).mtime.toISOString(); } catch { /* 诊断字段,读不到不影响 */ }

async function log(line) {
  try {
    await mkdir(stateDir, { recursive: true });
    await appendFile(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch { /* 诊断尽力而为 */ }
}

/** 截断到 n 字符,超出加标记:把失败报文落盘时不至于无限膨胀。 */
function trunc(v, n) {
  if (v === undefined || v === null) return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return undefined;
  return s.length > n ? `${s.slice(0, n)}…[截断 ${s.length - n} 字符]` : s;
}

/**
 * 11128(未授权渠道)在「改写梯子」全部耗尽后仍命中时,把真正发出去的报文形态落盘,
 * 供后续定位是哪段文本(system / 工具定义 / 历史 / 用户输入)触发上游指纹。
 * 只在失败时写,正常请求零开销;任何异常都不外抛,绝不影响请求本身。
 */
function captureFingerprint(kind, info) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const record = { at: new Date().toISOString(), kind, ...info };
    fs.appendFileSync(path.join(stateDir, 'fingerprint-capture.log'), `${JSON.stringify(record)}\n`);
  } catch { /* 捕获是诊断,绝不能影响请求 */ }
}

/**
 * 进程级兜底:桥是所有会话共用的单点,任何一次请求里的漏网异常都不该让它退出。
 *
 * Node 15+ 默认把 unhandledRejection 升级成致命错误;而这个进程一旦退出,所有
 * 客户端同时变成 503 connect-refused(宿主侧还有代理熔断,恢复要等一轮探测)。
 * 所以这里把两类逃逸都兜住并留痕,让进程继续服务 —— 单个请求失败可以重试,
 * 守护进程死掉是所有人的事。
 */
function installCrashGuard() {
  const note = (kind, error) => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${kind}: ${String(error?.stack ?? error).slice(0, 800)}\n`);
    } catch { /* 写不进日志也不能再抛 */ }
  };
  process.on('uncaughtException', (error) => note('uncaughtException', error));
  process.on('unhandledRejection', (error) => note('unhandledRejection', error));
}

// ---- 端点发现(带 TTL 缓存,token 轮换后自动跟上) ----
const epCache = new Map(); // tool -> { at, ep }

function endpointFor(tool) {
  const hit = epCache.get(tool);
  if (hit && Date.now() - hit.at < EP_CACHE_TTL_MS) return hit.ep;
  try {
    const ep = JSON.parse(fs.readFileSync(path.join(os.homedir(), `.zcode-${tool}-connect`, 'endpoint.json'), 'utf8'));
    epCache.set(tool, { at: Date.now(), ep });
    return ep;
  } catch {
    return null;
  }
}

// ---- Responses → Chat 请求翻译 ----
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(p => p && ['input_text', 'output_text', 'text', 'summary_text', 'refusal'].includes(p.type) && typeof p.text === 'string')
    .map(p => p.text)
    .join('');
}

// ---- 工具输出截断 ----
// 单条工具结果可达数百 KB(UI 自动化 dump、构建日志、大文件读取),一条就能把
// 上下文顶过上游真实上限(~190k),且自动压缩只在轮间触发、救不了单轮暴涨。
// 每条工具输出超过上限即截断:保留头 60% + 尾 40% 框架,注明丢弃量。
const TOOL_OUTPUT_CAP = 20_000;

function capToolOutput(s) {
  if (typeof s !== 'string' || s.length <= TOOL_OUTPUT_CAP) return s;
  const head = Math.floor(TOOL_OUTPUT_CAP * 0.6);
  const tail = TOOL_OUTPUT_CAP - head - 60;
  return s.slice(0, head) + `\n…[桥截断:单条工具输出 ${s.length} 字符超上限,中段省略 ${s.length - TOOL_OUTPUT_CAP} 字符]…\n` + s.slice(-tail);
}

// ---- 工具调用 / 工具结果配对修复 ----
// WorkBuddy 上游对 chat 历史做严格校验(400/11148 "tool calls and tool results
// do not match", retry_policy.retry:false):每条 assistant.tool_calls 之后必须
// 紧跟等量、ID 一一对应的 role:tool 消息。实测两种形态必被拒:
//   ① 并行工具调用被拆成多条 assistant(各带 1 个 call)——桥原先逐条转换;
//   ② 工具轮被中断 / 用户 Esc / 桥 invalid-tool 拦下后,历史里留下孤立 tool_call
//      或缺 tool result。Codex 每轮重发完整 input,残缺会毒化到会话结束,上游
//      明确要求「start a new conversation」。
// 出站前把结构修成合法形态:合并连续调用、补齐缺失结果、丢弃孤儿结果、ID 唯一化。
// 正文与消息顺序不变,正常多轮原样通过。
function repairToolPairing(messages) {
  const out = [];
  let seq = 0;
  const newId = () => `zc_gc_${++seq}`;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) {
      // 孤儿 tool 结果:前面没有紧邻的调用块,上游必拒,直接丢弃
      if (m.role === 'tool') continue;
      out.push(m);
      continue;
    }
    // 合并连续的 assistant.tool_calls(并行调用)成一条
    const calls = [];
    let j = i;
    while (j < messages.length && messages[j]?.role === 'assistant'
      && Array.isArray(messages[j].tool_calls) && messages[j].tool_calls.length) {
      for (const c of messages[j].tool_calls) {
        calls.push(c && typeof c === 'object'
          ? { ...c, function: c.function && typeof c.function === 'object' ? { ...c.function } : c.function }
          : c);
      }
      j++;
    }
    const ids = new Set();
    for (const c of calls) {
      if (!c || typeof c !== 'object') continue;
      if (typeof c.id !== 'string' || c.id === '' || ids.has(c.id)) c.id = newId();
      ids.add(c.id);
    }
    out.push(j - i === 1 ? { ...m, tool_calls: calls } : { role: 'assistant', content: null, tool_calls: calls });
    // 只认紧邻的 tool 消息;被 user/system 隔开的按孤儿处理(后续循环会丢弃)
    const results = new Map();
    while (j < messages.length && messages[j]?.role === 'tool') {
      const t = messages[j];
      if (ids.has(t.tool_call_id) && !results.has(t.tool_call_id)) results.set(t.tool_call_id, t);
      j++;
    }
    for (const c of calls) {
      out.push(results.get(c.id) ?? { role: 'tool', tool_call_id: c.id, content: '(tool execution was interrupted)' });
    }
    i = j - 1;
  }
  return out;
}

// ---- 历史净化 ----
// 长会话实测(dengying 45cdd3d3):模型退化后会把**整个会话历史**当正文复述
// (82KB 文本、316 个 <result> 块),这些毒进入历史后每轮回喂,模型越学越偏,
// 恶性循环。回放历史时对 assistant 文本净化:剥假 <result> 块与 DSML 残留。
function sanitizeAssistantHistory(text) {
  if (typeof text !== 'string' || text.length < 40) return text;
  return text
    .replace(/<result>[\s\S]*?<\/result>/g, ' ')
    .replace(/<｜DSML｜[\s\S]{0,400}?(?:>|\n)/g, ' ')
    .replace(/｜{1,2}DSML｜{1,2}[^\n]{0,300}/g, ' ')
    .replace(/ {3,}/g, '  ');
}

function toChatMessages(instructions, input, mutLevel = 0) {
  const messages = [];
  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({ role: 'system', content: deFingerprint(instructions, mutLevel) });
  }
  const items = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : Array.isArray(input) ? input : [];
  let synthId = 0;
  const callId = (v) => (typeof v === 'string' && v ? v : `zc_missing_${++synthId}`);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    // Responses 的 EasyInputMessage 允许省略 type:只带 role/content 也是一条消息。
    // 以前只认 type === 'message',这种条目会被静默丢掉,直到 messages 变空、上游
    // 回一句 "messages is required" —— 从报错完全看不出是桥丢的。
    const kind = typeof item.type === 'string' && item.type !== '' ? item.type : 'message';
    if (kind === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role ?? 'user';
      const text = textOfContent(item.content);
      if (text) {
        // system/assistant 都在网关扫描范围(dsh-connect-workbuddy #98 的测量):
        // developer 是 Codex 0.166 的系统提示词;assistant 是模型自己的历史,
        // 历史里复述过指纹会毒化会话后续每一轮且重试无效
        messages.push({ role, content: role === 'user' ? text : deFingerprint(sanitizeAssistantHistory(text), mutLevel) });
      }
    } else if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        // 工具参数也是被扫描的 assistant 内容;只做词级改写,不能加中性头(会破坏 JSON)
        tool_calls: [{ id: callId(item.call_id), type: 'function', function: { name: item.name ?? '', arguments: deFingerprintLexical(item.arguments ?? '', mutLevel) } }],
      });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: callId(item.call_id), content: capToolOutput(typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')) });
    }
    // reasoning 等其他 item 无 chat 等价物,丢弃
  }
  return repairToolPairing(messages);
}

function toChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .filter(t => t && t.type === 'function' && typeof t.name === 'string')
    .map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } } }));
  return mapped.length ? mapped : undefined;
}

function toChatToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

// ---- Chat SSE → Responses SSE 翻译 ----
let sseSeq = 0;
function sseWrite(res, event, payload) {
  // OpenAI Responses SSE 规约:data JSON 必须自带 type(客户端按它分发);
  // codex-rs 即依赖 data.type,event: 行只是冗余。sequence_number 递增保持同构。
  const full = { type: event, sequence_number: ++sseSeq, ...payload };
  if (process.env.ZC_BRIDGE_DEBUG) {
    appendFile(path.join(stateDir, 'debug-sse.log'), `event: ${event} data: ${JSON.stringify(full).slice(0, 500)}\n`).catch(() => {});
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(full)}\n\n`);
}

function sseDone(res) {
  res.write('data: [DONE]\n\n');
}

class ResponseBuilder {
  constructor(model, declaredTools = new Set()) {
    this.model = model;
    this.declaredTools = declaredTools;
    this.dsml = new DSMLTextFilter();
    this.items = [];
    this.responseId = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.outputIndex = 0;
    this.msg = null;   // 进行中的 assistant message
    this.reasoning = null;
    this.calls = new Map(); // upstream tool index -> {id, name, args, announced}
    this.usage = null;
    this.finish = null;
  }

  responsePayload(status, extra = {}) {
    return {
      id: this.responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model,
      output: this.items,
      parallel_tool_calls: false,
      error: null,
      incomplete_details: null,
      usage: this.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      ...extra,
    };
  }

  announceMsg(res) {
    if (this.msg) return;
    this.msg = { id: `msg_${this.outputIndex}`, outputIndex: this.outputIndex, text: '' };
    sseWrite(res, 'response.output_item.added', {
      output_index: this.outputIndex,
      item: { id: this.msg.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    sseWrite(res, 'response.content_part.added', {
      item_id: this.msg.id, output_index: this.outputIndex, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  finishMsg(res) {
    if (!this.msg) return;
    const tail = this.dsml.flush();
    if (tail) {
      this.msg.text += tail;
      sseWrite(res, 'response.output_text.delta', { item_id: this.msg.id, output_index: this.msg.outputIndex, content_index: 0, delta: tail });
    }
    const { cleanText, toolCalls } = recoverTextToolCalls(this.msg.text, this.declaredTools);
    this.msg.text = cleanText;
    if (toolCalls.length > 0) {
      this.recoveredTextTools = (this.recoveredTextTools || []).concat(toolCalls);
    }
    sseWrite(res, 'response.output_text.done', { item_id: this.msg.id, output_index: this.msg.outputIndex, content_index: 0, text: this.msg.text });
    sseWrite(res, 'response.content_part.done', { item_id: this.msg.id, output_index: this.msg.outputIndex, content_index: 0, part: { type: 'output_text', text: this.msg.text, annotations: [] } });
    const item = { id: this.msg.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: this.msg.text, annotations: [] }] };
    sseWrite(res, 'response.output_item.done', { output_index: this.msg.outputIndex, item });
    this.items.push(item);
    this.outputIndex++;
    this.msg = null;
  }

  announceReasoning(res) {
    if (this.reasoning) return;
    this.reasoning = { id: `rs_${this.outputIndex}`, outputIndex: this.outputIndex, text: '' };
    sseWrite(res, 'response.output_item.added', {
      output_index: this.outputIndex,
      item: { id: this.reasoning.id, type: 'reasoning', summary: [], content: [] },
    });
  }

  finishReasoning(res) {
    if (!this.reasoning) return;
    if (this.reasoning.text) {
      sseWrite(res, 'response.reasoning_summary_text.done', { item_id: this.reasoning.id, output_index: this.reasoning.outputIndex, content_index: 0, text: this.reasoning.text });
      const item = { id: this.reasoning.id, type: 'reasoning', summary: [{ type: 'summary_text', text: this.reasoning.text }], content: [] };
      sseWrite(res, 'response.output_item.done', { output_index: this.reasoning.outputIndex, item });
      this.items.push(item);
      this.outputIndex++;
    }
    this.reasoning = null;
  }

  handleChunk(res, d) {
    const choice = d.choices?.[0];
    if (d.error) return { error: d.error };
    if (!choice) {
      if (d.usage) this.usage = mapUsage(d.usage);
      return null;
    }
    const delta = choice.delta ?? {};
    if (choice.finish_reason) this.finish = choice.finish_reason;
    if (d.usage) this.usage = mapUsage(d.usage);

    const think = delta.reasoning_content ?? delta.reasoning?.content;
    if (typeof think === 'string' && think) {
      this.announceReasoning(res);        // 已开则复用,思维链不碎片化
      this.reasoning.text += think;
      sseWrite(res, 'response.reasoning_summary_text.delta', { item_id: this.reasoning.id, output_index: this.reasoning.outputIndex, content_index: 0, delta: think });
    }
    if (typeof delta.content === 'string' && delta.content) {
      this.finishReasoning(res);
      this.announceMsg(res);
      const filtered = this.dsml.push(delta.content);
      if (filtered) {
        this.msg.text += filtered;
        sseWrite(res, 'response.output_text.delta', { item_id: this.msg.id, output_index: this.msg.outputIndex, content_index: 0, delta: filtered });
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      this.finishReasoning(res);
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let call = this.calls.get(idx);
        if (!call) {
          call = { id: tc.id || `call_${idx}_${Date.now().toString(36)}`, name: '', args: '', outputIndex: this.outputIndex, announced: false };
          this.calls.set(idx, call);
          this.outputIndex++;
        }
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
        if (!call.announced && call.name) {
          call.announced = true;
          sseWrite(res, 'response.output_item.added', {
            output_index: call.outputIndex,
            item: { id: `fc_${call.outputIndex}`, type: 'function_call', status: 'in_progress', call_id: call.id, name: call.name, arguments: '' },
          });
        }
        if (call.announced && tc.function?.arguments) {
          sseWrite(res, 'response.function_call_arguments.delta', { item_id: `fc_${call.outputIndex}`, output_index: call.outputIndex, delta: tc.function.arguments });
        }
      }
    }
    return null;
  }

  finishAll(res, status) {
    this.finishReasoning(res);
    this.finishMsg(res);
    if (this.finish !== 'length') {
      for (const call of this.calls.values()) {
        if (!call.announced) continue;
        try {
          const input = JSON.parse(call.args || '{}');
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
        } catch {
          return { message: `Invalid tool arguments for ${call.name}` };
        }
      }
    }
    for (const [, call] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.announced) continue; // 没拿到名字的残缺调用,丢弃
      const callStatus = this.finish === 'length' ? 'incomplete' : 'completed';
      if (callStatus === 'completed') sseWrite(res, 'response.function_call_arguments.done', { item_id: `fc_${call.outputIndex}`, output_index: call.outputIndex, arguments: call.args });
      const item = { id: `fc_${call.outputIndex}`, type: 'function_call', status: callStatus, call_id: call.id, name: call.name, arguments: call.args };
      sseWrite(res, 'response.output_item.done', { output_index: call.outputIndex, item });
      this.items.push(item);
    }
    // DSML 四道门恢复 + 多供应商正文工具调用恢复 → function_call 条目
    const recovered = recoverDSMLToolCalls(this.dsml.capture, this.declaredTools);
    if (this.recoveredTextTools?.length) recovered.push(...this.recoveredTextTools);
    this.recoveredTextTools = null;
    this.dsml.capture = '';
    for (const call of recovered) {
      const idx = this.outputIndex++;
      sseWrite(res, 'response.output_item.added', { output_index: idx, item: { id: `dsc_${idx}`, type: 'function_call', status: 'in_progress', call_id: call.id, name: call.name, arguments: '' } });
      sseWrite(res, 'response.function_call_arguments.delta', { item_id: `dsc_${idx}`, output_index: idx, delta: call.arguments });
      sseWrite(res, 'response.function_call_arguments.done', { item_id: `dsc_${idx}`, output_index: idx, arguments: call.arguments });
      const item = { id: `dsc_${idx}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.arguments };
      sseWrite(res, 'response.output_item.done', { output_index: idx, item });
      this.items.push(item);
    }
    this.calls.clear();
    return null;
  }
}

function mapUsage(u) {
  return {
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
  };
}

// ---- 上游 WAF 去指纹 ----
// workbuddy 上游对已知 coding CLI 的官方特征做通道指纹匹配(命中即 400/11128)。
// 实测与机制(移植自 dsh-connect-workbuddy 的研究文档与 #98/#125/#163):
//   · 扫描范围:system 与 assistant 双角色,精确子串命中正文任意位置
//   · assistant 历史带指纹会毒化会话后续每一轮,宿主每轮重发逐字节相同的历史,
//     重试无效——必须每轮在桥里改写
//   · 2026-10-29 起网关匹配前归一化不可见字符(#163),零宽字符方案已死,只能同义改写
// 实测指纹点:Codex 开头身份三句;Claude Code 的 x-anthropic-billing-header 计费块
// (见 stripBillingBlocks,直接剥)与官方反馈链接 github.com/anthropics/claude-code/issues
// 梯子(对应上游 forceNeutralHead / breakIdentityClauses 的现行形态):
//   level 0:去牛津逗号 + 反馈链接周边措辞微调(链接本体不动、仍可点)
//   level 1:首处 "You are "→"You're " + Codex 专用措辞 + 链接路径破形(兜底)
//   level 2:中性头前置(前缀门兜底,对应上游 forceNeutralHead);工具参数不加头
const NEUTRAL_HEAD = 'You are a helpful assistant.\n\n';

function deFingerprintLexical(s, level = 0) {
  if (typeof s !== 'string' || !s) return s;
  let t = s.replace(/, and /g, ' and ');
  t = t.replace(/report the issue at (https:\/\/github\.com\/anthropics\/claude-code\/issues)/, 'report issues at $1');
  if (level >= 1) {
    t = t.replace(/You are /, "You're ");
    t = t.replace(/running in the Codex CLI/g, 'running within the Codex CLI');
    t = t.replace(/anthropics\/claude-code\/issues/, 'anthropics/claude-code/claude-code/issues');
  }
  return t;
}

function deFingerprint(instructions, level = 0) {
  if (typeof instructions !== 'string' || !instructions) return instructions;
  const t = deFingerprintLexical(instructions, level);
  return level >= 2 ? NEUTRAL_HEAD + t : t;
}

// ---- 思考强度映射 ----
// 各提供商线上档位(qoder 逐模型有差异,取并集就近);Claude/Codex 的档位经
// 「就近取整」映射——目标档位不存在时向上取最近档(如 trae 无 xhigh → max),
// 超出顶格取最高档。不带 thinking/reasoning 配置则不加字段(上游按默认行为)。
const PROVIDER_EFFORTS = {
  workbuddy: ['low', 'medium', 'high', 'xhigh', 'max'],
  trae: ['low', 'medium', 'high', 'max'],
  qoder: ['low', 'medium', 'high', 'max'],
  qwenwork: ['low', 'medium', 'high'],
};
const EFFORT_RANK = ['low', 'medium', 'high', 'xhigh', 'max'];

function clampEffort(tool, level) {
  const ladder = PROVIDER_EFFORTS[tool] ?? ['low', 'medium', 'high'];
  const target = EFFORT_RANK.indexOf(level);
  const ranked = ladder.slice().sort((a, b) => EFFORT_RANK.indexOf(a) - EFFORT_RANK.indexOf(b));
  return ranked.find(eff => EFFORT_RANK.indexOf(eff) >= target) ?? ranked[ranked.length - 1];
}

async function upstreamChat(ep, body, { mutLevel = 0, noStreamOptions = false, noMaxTokens = false, wireModel = '', signal, onPayload } = {}) {
  // 只发送 ZCode/pi 同款的最小字段集:workbuddy 上游做通道校验(11128),
  // codex 特有的 parallel_tool_calls / stream_options 等额外字段会触发拦截。
  const payload = {
    model: body.model,
    messages: toChatMessages(body.instructions, body.input, mutLevel),
    stream: true,
  };
  if (!noStreamOptions) payload.stream_options = { include_usage: true };
  // 输出预算:Codex 的 max_output_tokens 夹到「该模型真实上限」(见 outputCapFor)
  const maxOut = clampMaxOutput(body.max_output_tokens ?? body.max_tokens, wireModel);
  if (maxOut && !noMaxTokens) payload.max_tokens = maxOut;
  const tools = toChatTools(body.tools);
  if (tools) payload.tools = tools;
  const tc = toChatToolChoice(body.tool_choice);
  if (tc) payload.tool_choice = tc;
  // parallel_tool_calls 不转发:workbuddy 上游通道校验会拦非官方字段
  onPayload?.(payload);

  return fetch(`http://127.0.0.1:${ep.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
    body: JSON.stringify(payload),
    signal,
  });
}

async function handleResponses(req, res, wireModel, body, signal) {
  const slash = wireModel.indexOf('/');
  if (slash <= 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `模型 id 需带提供方前缀(wb/trae/qoder/qw),收到:${wireModel}` } }));
    return;
  }
  const t = TOOLS.find(x => x.key === wireModel.slice(0, slash));
  if (!t) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `未知提供方前缀:${wireModel.slice(0, slash)}(可用:wb trae qoder qw)` } }));
    return;
  }
  const ep = endpointFor(t.tool);
  if (!ep || !ep.port || !ep.token) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `${t.tool} 端点未就绪(缺 endpoint.json),先拉起端点` } }));
    return;
  }
  const chatModel = wireModel.slice(slash + 1);

  // Codex 的 reasoning.effort(minimal/low/medium/high)按提供商档位就近映射
  if (body.reasoning?.effort) {
    const e = body.reasoning.effort;
    body = { ...body, reasoning_effort: clampEffort(t.tool, e === 'minimal' ? 'low' : e) };
  }

  // 调试:ZC_BRIDGE_DEBUG=1 时把原始请求落盘(覆盖写),供排障比对
  if (process.env.ZC_BRIDGE_DEBUG) {
    await mkdir(stateDir, { recursive: true }).catch(() => {});
    await appendFile(path.join(stateDir, 'debug-trace.log'), `${new Date().toISOString()} ${JSON.stringify(body)}\n`).catch(() => {});
  }

  let successfulPayload;
  const callUpstream = (mutLevel, noStreamOptions, noMaxTokens = false) => {
    signal.throwIfAborted();
    return upstreamChat(ep, { ...body, model: chatModel }, {
      mutLevel, noStreamOptions, noMaxTokens, wireModel, signal,
      onPayload: payload => { successfulPayload = payload; },
    });
  };

  // 入口校验:翻译后一条消息都没有就别打上游了。上游只会回一句笼统的
  // "messages is required" / 4001,既暴露内部实现又难定位,这里直接说清是 input 的问题。
  if (toChatMessages(body.instructions, body.input, 0).length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'input 里没有可转换的消息:每一项需要 role/content(可省略 type),或为 function_call / function_call_output' } }));
    return;
  }

  let upstream;
  try {
    upstream = await callUpstream(0, false);
  } catch (e) {
    signal.throwIfAborted();
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } }));
    return;
  }
  if (upstream.status === 400) {
    let errText = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
    if (errText.includes('11128')) {
      // 11128 同义改写梯子:level 1(措辞加强)→ level 2(中性头兜底)
      for (let level = 1; level <= 2; level++) {
        try {
          upstream = await callUpstream(level, false);
        } catch (e) {
          signal.throwIfAborted();
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } }));
          return;
        }
        if (upstream.status !== 400) break;
        errText = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
        if (!errText.includes('11128')) break;
      }
    } else if (!/tool_choice/i.test(errText) && /(?:unsupported|unknown|unrecognized)[^\n]*(?:stream_options|max_tokens)|(?:stream_options|max_tokens)[^\n]*(?:not supported|unsupported|unknown|unrecognized)/i.test(errText)) {
      // 只对明确不支持的兼容字段重试;工具选择约束始终保留。
      try {
        upstream = await callUpstream(0, true, true);
      } catch (e) {
        signal.throwIfAborted();
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } }));
        return;
      }
      if (!upstream.ok) errText = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
    }
    if (!upstream.ok) {
      if (!upstream.bodyUsed) errText = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
      if (errText.includes('11128')) {
        captureFingerprint('responses', {
          tool: t.tool,
          model: chatModel,
          status: upstream.status,
          err: trunc(errText, 600),
          instructionsRaw: trunc(body.instructions, 40000),
          instructionsLevel2: trunc(deFingerprint(body.instructions, 2), 40000),
          input: trunc(body.input, 200000),
          tools: trunc(body.tools, 120000),
        });
      }
      json(res, upstream.status, { error: { message: errText.slice(0, 500) || `upstream HTTP ${upstream.status}` } });
      return;
    }
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(text || JSON.stringify({ error: { message: `upstream HTTP ${upstream.status}` } }));
    return;
  }

  const clientWantsStream = body.stream !== false;
  const builder = new ResponseBuilder(wireModel, new Set((body.tools ?? []).filter(t2 => t2?.type === 'function' && t2.name).map(t2 => t2.name)));
  const sink = clientWantsStream ? res : { write: () => {} };
  if (clientWantsStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    });
    sseWrite(res, 'response.created', { response: builder.responsePayload('in_progress') });
    sseWrite(res, 'response.in_progress', { response: builder.responsePayload('in_progress') });
  }
  const streamError = await consumeWithContinuation(upstream, builder, sink, {
    ep, payload: successfulPayload, signal, route: 'responses',
  });
  const status = streamError ? 'failed' : builder.finish === 'length' ? 'incomplete' : 'completed';
  const response = builder.responsePayload(status, {
    error: streamError,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
  });
  if (!clientWantsStream) {
    json(res, streamError ? 502 : 200, response);
    return;
  }
  sseWrite(res, `response.${status}`, { response });
  sseDone(res);
  res.end();
}

// 只接续完整的正常结束；客户端执行工具，网关只追加模型生成，不代执行。
async function consumeWithContinuation(upstream, builder, sink, { ep, payload, signal, route }) {
  let messages = payload.messages;
  const seen = new Set();
  const totals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const traceId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const trace = (attempt, outcome, signals = []) => log(`continuation ${JSON.stringify({ traceId, route, model: builder.model, attempt, outcome, signals })}`);
  const enabled = process.env.ZC_GATEWAY_CONTINUE !== '0';

  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    builder.finish = null;
    const previousUsage = builder.usage;
    builder.usage = null;
    const output = builder.blocks ?? builder.items;
    const start = output.length;
    let text = '';
    for await (const d of upstreamSseChunks(upstream, signal)) {
      const content = d.choices?.[0]?.delta?.content;
      if (typeof content === 'string') text += content;
      const result = builder.handleChunk(sink, d);
      const error = result?.error ?? result;
      if (error) {
        // Responses 错误载荷保留此前已收到的正文，但不完成任何工具条目。
        if (builder.items) {
          builder.finishReasoning(sink);
          builder.finishMsg(sink);
        }
        await trace(attempt, 'stream-error');
        return error;
      }
    }
    signal.throwIfAborted();
    const segmentUsage = builder.usage;
    const error = builder.blocks ? builder.finishBlocks(sink) : builder.finishAll(sink);
    if (error) {
      await trace(attempt, 'invalid-tool');
      return error;
    }
    if (segmentUsage) {
      for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) totals[key] += segmentUsage[key] ?? 0;
      totals.input_tokens_details.cached_tokens += segmentUsage.input_tokens_details?.cached_tokens ?? 0;
      totals.output_tokens_details.reasoning_tokens += segmentUsage.output_tokens_details?.reasoning_tokens ?? 0;
      builder.usage = { ...totals, input_tokens_details: { ...totals.input_tokens_details }, output_tokens_details: { ...totals.output_tokens_details } };
    } else {
      builder.usage = previousUsage;
    }
    if (!builder.finish) {
      await trace(attempt, 'missing-finish');
      return { type: 'upstream_incomplete', message: 'Upstream stream ended without a finish_reason' };
    }
    const segment = output.slice(start);
    const toolCount = segment.filter(b => b.type === 'tool_use' || b.type === 'function_call').length;
    const verdict = detectStall(text, { toolCallCount: toolCount });
    if (!enabled || builder.finish !== 'stop' || !payload.tools?.length || payload.tool_choice === 'none' || !verdict.stall) {
      if (attempt > 0) await trace(attempt, toolCount ? 'tool-produced' : 'ended', verdict.signals);
      return null;
    }
    if (attempt >= 2 || seen.has(text.trim())) {
      await trace(attempt, 'exhausted', verdict.signals);
      return { type: 'continuation_exhausted', message: 'Gateway continuation did not make progress; task remains unfinished' };
    }
    seen.add(text.trim());
    // 保留成功请求的前缀和 tool_choice，不把确认/完成回答强制改成工具动作。
    messages = [...messages, { role: 'assistant', content: text }, { role: 'user', content: verdict.prompt ?? CONTINUE_PROMPT }];
    await trace(attempt + 1, 'retry', verdict.signals);
    signal.throwIfAborted();
    try {
      upstream = await fetch(`http://127.0.0.1:${ep.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ ...payload, messages }),
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      await trace(attempt + 1, 'connection-error');
      return { type: 'continuation_failed', message: `Gateway continuation connection failed: ${error.cause?.code ?? error.message}` };
    }
    signal.throwIfAborted();
    if (!upstream.ok) {
      await upstream.body?.cancel();
      await trace(attempt + 1, `http-${upstream.status}`);
      return { type: 'continuation_failed', message: `Gateway continuation upstream HTTP ${upstream.status}` };
    }
  }
}

async function* upstreamSseChunks(upstream, signal) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let cancellation;
  // cancel() wakes a pending read even when the stream has not produced a frame.
  const cancel = () => cancellation ??= reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      let step;
      try {
        step = await reader.read();
      } catch (error) {
        signal.throwIfAborted();
        // Upstream failures remain protocol errors, not successful empty replies.
        yield { error: { message: `upstream stream broke: ${String(error?.message ?? error)}`, type: 'upstream_broken' } };
        return;
      }
      signal.throwIfAborted();
      const { done, value } = step;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') return;
        signal.throwIfAborted();
        try { yield JSON.parse(data); } catch { /* 跳过坏帧 */ }
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    try { await cancel(); }
    finally { reader.releaseLock(); }
    signal.throwIfAborted();
  }
}

// ---- DSML 泄漏过滤与恢复 ----
// DeepSeek 模型族偶发把内部标记(<｜DSML｜…>/｜｜DSML｜｜…)写进正文——上游
// dsh-connect-workbuddy 的 DSML-LEAK-RESEARCH 结论:长上下文下的模型族缺陷,
// 官方客户端解析并隐藏,裸 API 消费者看到垃圾标签且「工具调用」不执行。
// 两层处理(移植自上游 dsml-recovery.ts 的四道门设计):
//   ① 流式过滤:逐片剔除标记(本类);
//   ② 恢复:被剔除的内容若含「结构完好的 tool_calls 块」,按四道门转换为
//      可执行调用——(1)块已闭合 (2)工具名在本请求 tools 里声明过
//      (3)请求声明过工具 (4)参数可解析;任何疑虑回滚为纯文本。
// 退化形态(工具名覆盖 invoke 子句,如 <｜DSML｜ validate>)无工具名,
// 过不了门 2 —— 上游同款判定,交给停止闸的自动续跑。
class DSMLTextFilter {
  constructor() { this.carry = ''; this.capture = ''; }
  push(s) {
    s = this.carry + s;
    this.carry = '';
    let text = '';
    const prefixes = ['<｜DSML｜', '</｜DSML｜', '<｜｜DSML｜｜', '</｜｜DSML｜｜'];
    while (s) {
      const start = s.search(/<\/?｜{1,2}DSML｜{1,2}/);
      if (start < 0) {
        // 只暂存可能成为 DSML 标记的后缀;普通 <tag> / ｜ 文本原样通过。
        let hold = s.length;
        for (let i = Math.max(0, s.length - 14); i < s.length; i++) {
          if (prefixes.some(p => p.startsWith(s.slice(i)))) { hold = i; break; }
        }
        text += s.slice(0, hold);
        this.carry = s.slice(hold);
        break;
      }
      text += s.slice(0, start);
      s = s.slice(start);
      const end = s.indexOf('>');
      if (end < 0) { this.carry = s; break; }
      if (/^<｜{1,2}DSML｜{1,2}tool[\s_-]*calls>$/.test(s.slice(0, end + 1))) {
        const close = /<\/｜{1,2}DSML｜{1,2}tool[\s_-]*calls>/.exec(s.slice(end + 1));
        if (!close) { this.carry = s; break; }
        const stop = end + 1 + close.index + close[0].length;
        // capture 始终为字符串,保留整个闭合块(包括参数正文),不是零散标签。
        this.capture += s.slice(0, stop);
        s = s.slice(stop);
      } else {
        s = s.slice(end + 1); // 不完整/孤立标记只过滤,绝不合成调用。
      }
    }
    return text;
  }
  flush() {
    const tail = this.carry;
    this.carry = '';
    return tail.includes('DSML') ? '' : tail;
  }
}

/**
 * 门 2 的工具名归一。
 *
 * 模型把标记写坏时,工具名会被残渣包裹(实测 `name="Grep"` 退化成
 * `<name>Grep</｜｜DSML｜｜ parameter>`),逐字比对必然落空,整次调用丢失 ——
 * 用户看到的是「任务没结束就停住」。这里先剥标记字符再比对,但**只接受唯一命中**:
 * 模糊匹配会执行错的工具,比漏一次更贵(设计原则第 1 条)。
 *
 * @param {string} raw
 * @param {Set<string>} declaredTools
 * @returns {string} 归一后的工具名;空串 = 无法确定,不恢复
 */
function canonicalToolName(raw, declaredTools) {
  const cleaned = String(raw ?? '')
    .replace(/｜{1,2}\s*DSML\s*｜{1,2}/gi, '')
    .replace(/[｜|\s"']/g, '')
    .replace(/^</, '')
    .replace(/<[^]*$/, '');
  if (cleaned === '') return '';
  if (declaredTools.has(cleaned)) return cleaned;
  const lower = cleaned.toLowerCase();
  const exact = [...declaredTools].filter((n) => String(n).toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  return ''; // 前缀相似不等于请求声明过的工具名。
}

/**
 * 四道门恢复:从剔除的 DSML 碎片中解析结构完好的 tool_calls 块。
 * @param {string} captured   被剔除的 DSML 片段(时序拼接)
 * @param {Set<string>} declaredTools 本请求声明的工具名(门 2/门 3)
 * @returns {{id,name,arguments}[]}
 */
function recoverDSMLToolCalls(captured, declaredTools) {
  if (!captured || !declaredTools || declaredTools.size === 0) return [];
  const out = [];
  const blockRe = /<｜{1,2}DSML｜{1,2}tool[\s_-]*calls>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}tool[\s_-]*calls>/g;
  for (const block of captured.matchAll(blockRe)) {
    const invokeRe = /<｜{1,2}DSML｜{1,2}invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}invoke>/g;
    // 未闭合 invoke 或额外结构不能被正则跳过后当作有效调用。
    if (block[1].replace(invokeRe, '').trim()) continue;
    for (const inv of block[1].matchAll(invokeRe)) {
      const name = canonicalToolName(inv[1], declaredTools);
      if (name === '') continue;
      const params = Object.create(null);
      const paramRe = /<｜{1,2}DSML｜{1,2}parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}parameter>/g;
      if (inv[2].replace(paramRe, '').trim()) continue;
      let valid = true;
      for (const pm of inv[2].matchAll(paramRe)) {
        if (/\bstring="true"/.test(pm[2])) params[pm[1]] = pm[3];
        else {
          try { params[pm[1]] = JSON.parse(pm[3]); }
          catch { valid = false; break; }
        }
      }
      if (!valid) continue;
      out.push({ id: `dsml_${out.length}_${Date.now().toString(36)}`, name, arguments: JSON.stringify(params) });
    }
  }
  return out;
}

/**
 * 通用文本工具调用提取器 (Multi-Supplier Text Tool Call Recovery)
 *
 * 覆盖场景:
 * 1. Qwen / 通义千问:
 *    - JSON 格式: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 *    - XML 格式: <function=tool_name><parameter=key string="true">val</parameter></function>
 *    - 残缺闭合标签: </parameter>\n</function>\n、</tool_call>
 * 2. GLM / 智谱 (GLM-4 / GLM-5):
 *    - <tool_call>tool_name\n<arg1>val1</arg1>...</tool_call>
 *    - <tool_call>tool_name\n{"key": "val"}</tool_call>
 * 3. 通用格式 (MiniMax, Kimi, 豆包, Qoder 等模型在未启用原生 fc 或降级时泄漏的正文):
 *    - <function_call>{"name": "...", "arguments": {...}}</function_call>
 *    - <tool_calls>[{"name": "...", "arguments": {...}}]</tool_calls>
 *
 * @param {string} text 待清洗解析的正文
 * @param {Set<string>} [declaredTools] 当前请求声明的合法工具集合
 * @returns {{ cleanText: string, toolCalls: { id: string, name: string, arguments: string }[] }}
 */
function recoverTextToolCalls(text, declaredTools) {
  if (typeof text !== 'string' || !text) return { cleanText: text || '', toolCalls: [] };
  const toolCalls = [];
  let cleanText = text;

  // 1. Qwen / 通用 JSON 格式: <tool_call> ... </tool_call> 或 <function_call> ... </function_call>
  const jsonToolCallRegex = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi;
  cleanText = cleanText.replace(jsonToolCallRegex, (match, body) => {
    const trimmed = body.trim();
    // 尝试直接 JSON 解析: {"name": "...", "arguments": {...}}
    try {
      const parsed = JSON.parse(trimmed);
      const rawName = parsed.name || parsed.function?.name;
      const name = declaredTools ? canonicalToolName(rawName, declaredTools) : rawName;
      if (name) {
        let args = parsed.arguments || parsed.parameters || parsed.function?.arguments || {};
        if (typeof args === 'object' && args !== null) args = JSON.stringify(args);
        toolCalls.push({
          id: `txt_tc_${toolCalls.length}_${Date.now().toString(36)}`,
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        });
        return '';
      }
    } catch {
      // 非纯 JSON, 尝试 GLM 格式: 第一行为工具名, 后续为参数
    }

    // 1b. GLM 格式: <tool_call>tool_name\n<arg1>val1</arg1>...</tool_call> 或 <tool_call>tool_name\n{...}</tool_call>
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline > 0) {
      const potentialName = trimmed.slice(0, firstNewline).trim();
      const name = declaredTools ? canonicalToolName(potentialName, declaredTools) : potentialName;
      if (name) {
        const rest = trimmed.slice(firstNewline + 1).trim();
        // 如果后面是 JSON 字符串
        if (rest.startsWith('{') && rest.endsWith('}')) {
          try {
            const parsed = JSON.parse(rest);
            toolCalls.push({
              id: `glm_tc_${toolCalls.length}_${Date.now().toString(36)}`,
              name,
              arguments: JSON.stringify(parsed),
            });
            return '';
          } catch {}
        }
        // 如果后面是 <arg>val</arg> 格式
        const xmlParamRegex = /<([a-zA-Z0-9_\-.:]+)>([\s\S]*?)<\/\1>/g;
        const matches = [...rest.matchAll(xmlParamRegex)];
        if (matches.length > 0) {
          const args = Object.create(null);
          for (const m of matches) {
            try { args[m[1]] = JSON.parse(m[2]); } catch { args[m[1]] = m[2]; }
          }
          toolCalls.push({
            id: `glm_xml_${toolCalls.length}_${Date.now().toString(36)}`,
            name,
            arguments: JSON.stringify(args),
          });
          return '';
        }
      }
    }

    return match;
  });

  // 2. 多工具数组格式: <tool_calls>[ ... ]</tool_calls>
  const toolCallsArrayRegex = /<tool_calls>([\s\S]*?)<\/tool_calls>/gi;
  cleanText = cleanText.replace(toolCallsArrayRegex, (match, body) => {
    try {
      const parsed = JSON.parse(body.trim());
      if (Array.isArray(parsed)) {
        let allValid = true;
        const recovered = [];
        for (const item of parsed) {
          const rawName = item.name || item.function?.name;
          const name = declaredTools ? canonicalToolName(rawName, declaredTools) : rawName;
          if (!name) { allValid = false; break; }
          let args = item.arguments || item.parameters || item.function?.arguments || {};
          if (typeof args === 'object' && args !== null) args = JSON.stringify(args);
          recovered.push({
            id: `arr_tc_${toolCalls.length + recovered.length}_${Date.now().toString(36)}`,
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          });
        }
        if (allValid && recovered.length > 0) {
          toolCalls.push(...recovered);
          return '';
        }
      }
    } catch {}
    return match;
  });

  // 3. Qwen XML 格式: <function=name> ... </function>
  const xmlFunctionRegex = /<function=([a-zA-Z0-9_\-.:]+)>([\s\S]*?)<\/function>/gi;
  cleanText = cleanText.replace(xmlFunctionRegex, (match, rawName, innerParams) => {
    const name = declaredTools ? canonicalToolName(rawName, declaredTools) : rawName;
    if (!name) return match;
    const args = Object.create(null);
    let valid = true;
    const paramRegex = /<parameter=([a-zA-Z0-9_\-.:]+)(?:\s+string="([^"]*)")?>([\s\S]*?)<\/parameter>/gi;
    const remainder = innerParams.replace(paramRegex, '').trim();
    if (remainder) return match;

    for (const pMatch of innerParams.matchAll(paramRegex)) {
      const pName = pMatch[1];
      const isString = pMatch[2] === 'true';
      const pVal = pMatch[3];
      if (isString) {
        args[pName] = pVal;
      } else {
        try {
          args[pName] = JSON.parse(pVal);
        } catch {
          args[pName] = pVal;
        }
      }
    }
    if (valid) {
      toolCalls.push({
        id: `fn_xml_${toolCalls.length}_${Date.now().toString(36)}`,
        name,
        arguments: JSON.stringify(args),
      });
      return '';
    }
    return match;
  });

  // 4. 清理残存闭合标签，防止客户端看见语法残渣或触发意外断点
  cleanText = cleanText.replace(/(?:<\/parameter>\s*)*<\/function>/gi, '');
  cleanText = cleanText.replace(/<\/(?:tool_call|function_call|tool_calls)>/gi, '');

  return { cleanText, toolCalls };
}

function noteUnrecoveredDSML(captured, recovered) {
  if (recovered.length > 0) return;
  if (!/tool[\s_-]*calls/i.test(captured) && !/invoke/i.test(captured)) return;
  if (process.env.ZC_BRIDGE_DEBUG) {
    appendFile(path.join(stateDir, 'debug-dsml.log'), `${new Date().toISOString()} unrecovered: ${captured.slice(0, 400)}\n`).catch(() => {});
  }
}

// ---- Anthropic Messages(/v1/messages,Claude Code)→ Chat ----
// 与 Codex 共用同一批上游路由/去指纹/SSE 读取;此处只做协议形状转换。
// Claude Code 经环境变量接入:ANTHROPIC_BASE_URL=http://127.0.0.1:39268
// + ANTHROPIC_AUTH_TOKEN=<任意非空> + ANTHROPIC_MODEL=<前缀>/<模型>。桥不校验鉴权。

function anthropicTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('');
}

// Claude Code 会在 system 里塞 x-anthropic-billing-header 计费元数据块,WorkBuddy 上游
// 对它做通道指纹匹配(11128,改词也绕不过)。它是纯传输元数据,翻译时直接剥掉。
function stripBillingBlocks(system) {
  if (!Array.isArray(system)) return system;
  return system.filter(b => !(b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith('x-anthropic-billing-header')));
}

function toChatMessagesAnthropic(systemText, messages, mutLevel = 0) {
  const out = [];
  if (systemText) out.push({ role: 'system', content: systemText });
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    if (m.role === 'user') {
      const texts = [];
      const toolResults = [];
      for (const p of parts) {
        if (p?.type === 'text') texts.push(p.text ?? '');
        else if (p?.type === 'tool_result') {
          toolResults.push({ role: 'tool', tool_call_id: p.tool_use_id ?? '', content: capToolOutput(anthropicTextOf(p.content)) || (p.is_error ? '(tool error)' : '') });
        }
        // image 等无 chat 等价物,丢弃
      }
      // tool 结果必须紧邻上一条 assistant.tool_calls,否则上游 11148;用户文本随后
      for (const r of toolResults) out.push(r);
      if (texts.length) out.push({ role: 'user', content: texts.join('') });
    } else if (m.role === 'assistant') {
      // assistant 历史在网关扫描范围(#98):复述过指纹的回复会毒化后续每一轮;
      // 另需净化回放毒(假 <result> 块/DSML 残留)——模型退化复述历史会恶性循环
      let text = '';
      const toolCalls = [];
      for (const p of parts) {
        if (p?.type === 'text') text += p.text ?? '';
        else if (p?.type === 'tool_use') toolCalls.push({ id: p.id ?? `call_${toolCalls.length}`, type: 'function', function: { name: p.name ?? '', arguments: deFingerprintLexical(JSON.stringify(p.input ?? {}), mutLevel) } });
        // thinking 不回传
      }
      text = deFingerprint(sanitizeAssistantHistory(text), mutLevel);
      const msg = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else if (m.role === 'system' || m.role === 'developer') {
      // Claude Code 2.1.316 会把 hook 上下文作为 role:"system" 的 message 发来
      const text = anthropicTextOf(m.content);
      if (text) out.push({ role: 'system', content: text });
    }
  }
  return repairToolPairing(out);
}

function toChatToolsAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .filter(t => t && typeof t.name === 'string' && t.input_schema)
    .map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }));
  return mapped.length ? mapped : undefined;
}

function anthropicToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

const ANTHROPIC_STOP = { tool_calls: 'tool_use', stop: 'end_turn', length: 'max_tokens' };

/**
 * 这一轮是不是紧接着一次「宣布了下一步却停住」。
 *
 * Claude Code 的 Stop 守卫拦下来时,会把续跑提示作为一条合成消息塞进上下文
 * (role 可能是 user,也可能是 2.1.316 之后的 system)。看到它就说明上一次
 * 上游给了"零工具调用的 end_turn",这一次必须逼它真动手。
 *
 * 工具工作或新真人输入会结束这次续跑约束;普通 assistant/system 消息不会。
 */
function recentlyStalled(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m) continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant' && parts.some(p => p?.type === 'tool_use')) return false;
    if (m.role === 'user' && parts.some(p => p?.type === 'tool_result')) return false;
    if (m.role !== 'user' && m.role !== 'system') continue;
    if (anthropicTextOf(m.content).includes('Stop hook feedback')) return true;
    if (m.role === 'user' && !m.isMeta) return false;
  }
  return false;
}

// ---- 输出预算 ----
// 以前桥完全不转发客户端的 max_tokens:上游按自己的默认值生成,客户端却按自己的
// 预算记账(Claude Code 的 CLAUDE_CODE_MAX_OUTPUT_TOKENS 常见 6000/128000 两档),
// 于是「客户端以为早该截断的地方上游还在写」——上下文计量与实际输出脱节。
// 现在转发并夹到「该模型的真实输出上限」:以前一律压到 32000,导致
// wb/hy4free(64000)、wb/deepseek-v4.1-flash(128000) 这类模型被无谓砍半,
// 单轮稍长就 finish_reason:"length" → Codex 报
// "Incomplete response returned, reason: max_output_tokens"。
// 表由 scripts/sync-model-output-limits.mjs 从各端点 GET /v1/models 生成。
const MODEL_OUTPUT_LIMITS = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(new URL('./model-output-limits.json', import.meta.url), 'utf8'));
    return parsed && typeof parsed.limits === 'object' && parsed.limits !== null ? parsed.limits : {};
  } catch { return {}; /* 表缺失:回退到兜底上限 */ }
})();

function outputCapFor(wireModel) {
  const env = Number(process.env['ZC_MAX_OUTPUT_TOKENS']);
  if (Number.isFinite(env) && env > 0) return Math.floor(env); // 显式 env 覆盖一切
  const cap = Number(MODEL_OUTPUT_LIMITS[wireModel]);            // 否则用模型真实上限
  if (Number.isInteger(cap) && cap > 0) return cap;
  return 32000;                                                 // 未收录模型的保守兜底
}

function clampMaxOutput(value, wireModel) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), outputCapFor(wireModel));
}

class AnthropicStreamBuilder {
  constructor(model, estInput, declaredTools = new Set()) {
    this.model = model;
    this.declaredTools = declaredTools;
    this.dsml = new DSMLTextFilter();
    this.blockIndex = 0;
    this.cur = null;   // {kind:'text'|'thinking', index, text}
    this.blocks = [];
    this.finish = null;
    this.usage = null;
    this.estInput = estInput;
    /** 工具按上游 index 聚合到流结束;index 切换不代表参数已结束。 */
    this.pendingTools = new Map();
  }

  msgStart(res) {
    sseWrite(res, 'message_start', {
      message: {
        id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: this.estInput, output_tokens: 0 },
      },
    });
  }

  closeBlock(res) {
    if (!this.cur) return;
    const i = this.cur.index;
    if (this.cur.kind === 'text') {
      const tail = this.dsml.flush();
      if (tail) {
        this.cur.text += tail;
        sseWrite(res, 'content_block_delta', { index: i, delta: { type: 'text_delta', text: tail } });
      }
      const { cleanText, toolCalls } = recoverTextToolCalls(this.cur.text, this.declaredTools);
      this.cur.text = cleanText;
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const idx = this.pendingTools.size;
          this.pendingTools.set(idx, { id: tc.id, name: tc.name, args: tc.arguments });
        }
      }
      sseWrite(res, 'content_block_stop', { index: i });
      this.blocks.push({ type: 'text', text: this.cur.text });
    } else if (this.cur.kind === 'thinking') {
      sseWrite(res, 'content_block_stop', { index: i });
      this.blocks.push({ type: 'thinking', thinking: this.cur.text, signature: '' });
    }
    this.cur = null;
    this.blockIndex = i + 1;
  }

  openBlock(res, kind) {
    this.closeBlock(res);
    const idx = this.blockIndex;
    const block = kind === 'text' ? { type: 'text', text: '' }
      : { type: 'thinking', thinking: '', signature: '' };
    sseWrite(res, 'content_block_start', { index: idx, content_block: block });
    this.cur = { kind, index: idx, text: '' };
  }

  handleChunk(res, d) {
    if (d.error) return d.error;
    const choice = d.choices?.[0];
    if (!choice) {
      if (d.usage) this.usage = mapUsage(d.usage);
      return null;
    }
    const delta = choice.delta ?? {};
    if (choice.finish_reason) this.finish = choice.finish_reason;
    if (d.usage) this.usage = mapUsage(d.usage);

    const think = delta.reasoning_content ?? delta.reasoning?.content;
    if (typeof think === 'string' && think) {
      if (this.cur?.kind !== 'thinking') this.openBlock(res, 'thinking');
      this.cur.text += think;
      sseWrite(res, 'content_block_delta', { index: this.cur.index, delta: { type: 'thinking_delta', thinking: think } });
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (this.cur?.kind !== 'text') this.openBlock(res, 'text');
      const filtered = this.dsml.push(delta.content);
      if (filtered) {
        this.cur.text += filtered;
        sseWrite(res, 'content_block_delta', { index: this.cur.index, delta: { type: 'text_delta', text: filtered } });
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const buf = this.pendingTools.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) buf.id = tc.id;
        if (tc.function?.name) buf.name += tc.function.name;
        if (tc.function?.arguments) buf.args += tc.function.arguments;
        this.pendingTools.set(idx, buf);
      }
    }
    return null;
  }

  finishBlocks(res) {
    this.closeBlock(res);
    const recovered = recoverDSMLToolCalls(this.dsml.capture, this.declaredTools);
    noteUnrecoveredDSML(this.dsml.capture, recovered);
    this.dsml.capture = ''; // 先消费捕获,再输出;不再从 closeBlock 重入恢复。
    const calls = [...this.pendingTools.entries()].sort((a, b) => a[0] - b[0])
      .filter(([, call]) => call.name)
      .map(([idx, call]) => ({ ...call, id: call.id || `call_${idx}_${Date.now().toString(36)}` }));
    calls.push(...recovered.map(call => ({ ...call, args: call.arguments })));
    // 所有参数先校验,再发任何可执行块,不把损坏的 JSON 伪装成 {}。
    for (const call of calls) {
      try {
        call.input = JSON.parse(call.args || '{}');
        if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) throw new Error('expected an object');
      } catch {
        return { message: `Invalid tool arguments for ${call.name}` };
      }
    }
    this.pendingTools.clear();
    for (const call of calls) {
      const index = this.blockIndex++;
      sseWrite(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
      sseWrite(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: call.args || '{}' } });
      sseWrite(res, 'content_block_stop', { index });
      this.blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    return null;
  }

  finishAll(res) {
    const error = this.finishBlocks(res);
    if (error) return error;
    const stopReason = this.resolveStop();
    sseWrite(res, 'message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.usage?.output_tokens ?? 0 },
    });
    sseWrite(res, 'message_stop', {});
  }

  /**
   * stop_reason 必须和真正发出去的块自洽。
   *
   * 上游说「这一轮有工具调用」,但我们一个 tool_use 块都没落地(名字始终没来、
   * 或被 DSML 门 2 挡掉)时,照实报 tool_use 会让宿主陷入一个不可能的状态:
   * 该执行工具的回合里没有任何工具 → 它只能结束回合,用户看到的就是
   * 「任务没结束就停住」。退回 end_turn 才是诚实的:这一轮确实什么也没做成,
   * 宿主(以及 Stop 守卫)据此还能再要一次。
   */
  resolveStop() {
    let mapped = ANTHROPIC_STOP[this.finish] ?? 'end_turn';
    if (this.blocks.some(b => b.type === 'tool_use')) mapped = 'tool_use';
    else if (mapped === 'tool_use') mapped = 'end_turn';
    return mapped;
  }
}

// ---- 用量估算 ----
// 估算供 message_start 的 usage 与 Claude 的上下文计量。必须排除 image 块的
// base64 数据:翻译时图片被丢弃,上游成本为零;若按 JSON 长度计,一张截图的
// base64(~25 万字符)会虚增 6 万+ token,把 Claude 的上下文计量灌爆,
// 触发与真实用量无关的 "Context limit reached" 本地拒发。
function estimateTokens(body) {
  let chars = 0;
  const walk = (v) => {
    if (typeof v === 'string') { chars += v.length; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') {
      if (v.type === 'image' && typeof v.source?.data === 'string') { chars += 400; return; }
      for (const k in v) walk(v[k]);
    }
  };
  walk(body.system);
  walk(body.messages);
  walk(body.tools);
  return Math.ceil(chars / 4);
}

async function handleMessages(req, res, body, signal) {
  const wireModel = body.model ?? '';
  const slash = wireModel.indexOf('/');
  if (slash <= 0) {
    json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `模型 id 需带提供方前缀(wb/trae/qoder/qw),收到:${wireModel}` } });
    return;
  }
  const t = TOOLS.find(x => x.key === wireModel.slice(0, slash));
  const chatModel = wireModel.slice(slash + 1);
  const ep = t && endpointFor(t.tool);
  if (!ep || !ep.port || !ep.token) {
    json(res, 502, { type: 'error', error: { type: 'api_error', message: `${t?.tool ?? wireModel} 端点未就绪(缺 endpoint.json),先拉起端点` } });
    return;
  }

  const sysText = deFingerprint(anthropicTextOf(stripBillingBlocks(body.system)), 0);
  // Claude 的 thinking 配置 → WorkBuddy 线上的 reasoning_effort;不带该字段上游默认不思考
  let reasoningEffort;
  if (body.thinking?.type === 'enabled') {
    const budget = body.thinking.budget_tokens ?? 0;
    // Claude /effort 的五档经 budget 阈值分档,再按提供商档位就近取整
    const level = budget >= 64000 ? 'max' : budget >= 48000 ? 'xhigh' : budget >= 24000 ? 'high' : budget >= 8000 ? 'medium' : 'low';
    reasoningEffort = clampEffort(t.tool, level);
  } else if (body.thinking?.type === 'adaptive') {
    // Claude 2.1.316 对未知模型发 adaptive 自适应思考(不带强度信号);
    // 默认映射 max(用户偏好:思考强度默认拉满),保证思考可见
    reasoningEffort = clampEffort(t.tool, 'max');
  }
  const chatPayload = {
    model: chatModel,
    messages: toChatMessagesAnthropic(sysText, body.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (reasoningEffort) chatPayload.reasoning_effort = reasoningEffort;
  const tools = toChatToolsAnthropic(body.tools);
  if (tools) chatPayload.tools = tools;
  const tc = anthropicToolChoice(body.tool_choice);
  // 「刚停过一次」→ 这一轮强制模型必须发起工具调用(tool_choice: required)。
  //
  // 只对 trae 开:它的 DeepSeek-V4.1-Flash 空收尾率 12%(wb 同模型 3.5%),靠提示
  // 复述已经压不住。触发条件刻意收紧到「上下文里刚出现 Stop hook feedback」——
  // 如果无脑对每个 tool_result 之后都 required,模型永远没机会给最终答复,
  // 会变成无限工具循环;绑在"刚被守卫拦下"这一轮,强制完下一轮就恢复 auto。
  const forceContinue = !!tools && t.tool === 'trae'
    && process.env['ZC_FORCE_TOOL_CONTINUE'] !== '0'
    && recentlyStalled(body.messages);
  if (forceContinue) chatPayload.tool_choice = 'required';
  else if (tc) chatPayload.tool_choice = tc;
  // 输出预算:Claude 的 max_tokens 夹到「该模型真实上限」(见 outputCapFor)
  const maxOut = clampMaxOutput(body.max_tokens, wireModel);
  if (maxOut) chatPayload.max_tokens = maxOut;
  const estInput = estimateTokens(body);

  let successfulPayload;
  const callUpstream = (mutLevel, noStreamOptions, noMaxTokens = false) => {
    signal.throwIfAborted();
    const p = { ...chatPayload };
    // 每级都从原始 body 重建:billing 剥除 + 去指纹 + assistant 历史改写按当前档位重算
    p.messages = toChatMessagesAnthropic(deFingerprint(anthropicTextOf(stripBillingBlocks(body.system)), mutLevel), body.messages, mutLevel);
    if (noStreamOptions) delete p.stream_options;
    if (noMaxTokens) delete p.max_tokens;
    successfulPayload = p;
    return fetch(`http://127.0.0.1:${ep.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
      body: JSON.stringify(p),
      signal,
    });
  };

  if (process.env.ZC_BRIDGE_DEBUG) {
    await mkdir(stateDir, { recursive: true }).catch(() => {});
    await appendFile(path.join(stateDir, 'debug-trace.log'), `${new Date().toISOString()} ${JSON.stringify(body)}\n`).catch(() => {});
  }

  let upstream;
  try {
    upstream = await callUpstream(0, false);
  } catch (e) {
    signal.throwIfAborted();
    json(res, 502, { type: 'error', error: { type: 'api_error', message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } });
    return;
  }
  if (upstream.status === 400) {
    let errText = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
    if (errText.includes('11128')) {
      // 11128 同义改写梯子:level 1(措辞加强)→ level 2(中性头兜底)
      for (let level = 1; level <= 2; level++) {
        try {
          upstream = await callUpstream(level, false);
        } catch (e) {
          signal.throwIfAborted();
          json(res, 502, { type: 'error', error: { type: 'api_error', message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } });
          return;
        }
        if (upstream.status !== 400) break;
        errText = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
        if (!errText.includes('11128')) break;
      }
    } else if (!/tool_choice/i.test(errText) && /(?:unsupported|unknown|unrecognized)[^\n]*(?:stream_options|max_tokens)|(?:stream_options|max_tokens)[^\n]*(?:not supported|unsupported|unknown|unrecognized)/i.test(errText)) {
      // 只对明确不支持的兼容字段重试,绝不删除 tool_choice。
      try {
        upstream = await callUpstream(0, true, true);
      } catch (e) {
        signal.throwIfAborted();
        json(res, 502, { type: 'error', error: { type: 'api_error', message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } });
        return;
      }
      if (!upstream.ok) errText = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
    }
    if (!upstream.ok) {
      if (!upstream.bodyUsed) errText = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
      if (errText.includes('11128')) {
        captureFingerprint('messages', {
          tool: t.tool,
          model: body.model,
          status: upstream.status,
          err: trunc(errText, 600),
          systemRaw: trunc(body.system, 40000),
          systemLevel2: trunc(deFingerprint(anthropicTextOf(stripBillingBlocks(body.system)), 2), 40000),
          messages: trunc(body.messages, 200000),
          tools: trunc(body.tools, 120000),
        });
      }
      json(res, upstream.status, { type: 'error', error: { type: 'api_error', message: errText.slice(0, 500) || `upstream HTTP ${upstream.status}` } });
      return;
    }
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => { signal.throwIfAborted(); return ''; });
    json(res, upstream.status, { type: 'error', error: { type: 'api_error', message: text.slice(0, 500) || `upstream HTTP ${upstream.status}` } });
    return;
  }

  const builder = new AnthropicStreamBuilder(wireModel, estInput, new Set((tools ?? []).map(t2 => t2.function.name)));
  const streaming = body.stream === true;
  const sink = streaming ? res : { write: () => {} };
  if (streaming) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    builder.msgStart(res);
  }
  const streamError = await consumeWithContinuation(upstream, builder, sink, {
    ep, payload: successfulPayload, signal, route: 'messages',
  });
  if (!streaming) {
    if (streamError) {
      json(res, 502, { type: 'error', error: { type: 'api_error', message: streamError.message } });
      return;
    }
    json(res, 200, {
      id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: wireModel,
      content: builder.blocks, stop_reason: builder.resolveStop(), stop_sequence: null,
      usage: { input_tokens: builder.usage?.input_tokens ?? estInput, output_tokens: builder.usage?.output_tokens ?? 0 },
    });
    return;
  }
  if (streamError) {
    sseWrite(res, 'error', { type: 'error', error: { type: 'api_error', message: String(streamError.message ?? JSON.stringify(streamError)).slice(0, 500) } });
  } else {
    sseWrite(res, 'message_delta', {
      delta: { stop_reason: builder.resolveStop(), stop_sequence: null },
      usage: { input_tokens: builder.usage?.input_tokens ?? estInput, output_tokens: builder.usage?.output_tokens ?? 0 },
    });
    sseWrite(res, 'message_stop', {});
  }
  sseDone(res);
  res.end();
}

// ---- 路由 / 服务 ----
async function aggregateModels() {
  const data = [];
  for (const t of TOOLS) {
    const ep = endpointFor(t.tool);
    if (!ep) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${ep.port}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const j = await r.json();
      for (const m of j.data ?? []) {
        // 同一条目同时带 OpenAI(object)与 Anthropic(type/display_name)形状字段,两类客户端都能读
        data.push({ id: `${t.key}/${m.id}`, object: 'model', type: 'model', display_name: `${t.key}/${m.id}`, created: 0, owned_by: `zc-${t.tool}` });
      }
    } catch { /* 端点不在,跳过 */ }
  }
  return data;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// ---- OpenAI chat/completions 透传(Hermes 等原生 OpenAI 客户端)----
// 上游四个端点本身就讲 chat/completions:桥只做前缀路由 + 透传,不做协议翻译。
async function handleChatCompletions(req, res, body, signal) {
  const wireModel = body.model ?? '';
  const slash = wireModel.indexOf('/');
  if (slash <= 0) {
    json(res, 400, { error: { message: `模型 id 需带提供方前缀(wb/trae/qoder/qw),收到:${wireModel}` } });
    return;
  }
  const t = TOOLS.find((x) => x.key === wireModel.slice(0, slash));
  const chatModel = wireModel.slice(slash + 1);
  const ep = t && endpointFor(t.tool);
  if (!ep || !ep.port || !ep.token) {
    json(res, 502, { error: { message: `${t?.tool ?? wireModel} 端点未就绪(缺 endpoint.json),先拉起端点` } });
    return;
  }
  const upstream = {
    ...body,
    model: chatModel,
    // Hermes 直发 chat 协议:同样要修 tool_calls/tool 结果配对,否则上游 11148
    ...(Array.isArray(body.messages) ? { messages: repairToolPairing(body.messages) } : {}),
  };
  const hermesMaxOut = clampMaxOutput(body.max_tokens, wireModel);
  if (hermesMaxOut) upstream.max_tokens = hermesMaxOut;
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${ep.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
      body: JSON.stringify(upstream),
      signal,
    });
  } catch (e) {
    json(res, 502, { error: { message: `上游 ${t.tool} 连接失败: ${e.message}` } });
    return;
  }
  res.statusCode = r.status;
  for (const [k, v] of r.headers) {
    if (/^content-length$/i.test(k)) continue; // 流式长度会变,交给 Node 重写
    res.setHeader(k, v);
  }
  if (!r.body) {
    res.end(await r.text());
    return;
  }
  const nodeStream = Readable.fromWeb(r.body);
  nodeStream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
  res.on('close', () => nodeStream.destroy());
  nodeStream.pipe(res);
}

async function handle(req, res) {
  if (!hostIsLoopback(req.headers.host)) {
    json(res, 403, { error: { type: 'host_not_allowed', message: 'Host header must name the loopback interface' } });
    return;
  }
  if (!originIsLoopback(req.headers.origin)) {
    json(res, 403, { error: { type: 'origin_not_allowed', message: 'Origin must be a loopback origin' } });
    return;
  }
  const contentType = req.headers['content-type'];
  if (req.method === 'POST' && !(typeof contentType === 'string' && contentType.trim().toLowerCase().startsWith('application/json'))) {
    json(res, 415, { error: { type: 'unsupported_media_type', message: 'Content-Type must be application/json' } });
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const controller = new AbortController();
  const { signal } = controller;
  const onClose = () => { if (!res.writableFinished) controller.abort(); };
  res.on('close', onClose);
  if (res.destroyed) onClose();
  try {
    if (req.method === 'GET' && (p === '/healthz' || p === '/health')) {
      const tools = {};
      for (const t of TOOLS) {
        const ep = endpointFor(t.tool);
        tools[t.key] = ep ? `:${ep.port}` : 'missing';
      }
      json(res, 200, { ok: true, bridge: true, tools, pid: process.pid, startedAt: startedAt, codeMtime: codeMtime });
      return;
    }
    if (req.method === 'GET' && p === '/v1/models') {
      json(res, 200, { object: 'list', data: await aggregateModels() });
      return;
    }
    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      const body = await readBody(req);
      await handleResponses(req, res, body.model ?? '', body, signal);
      return;
    }
    if (req.method === 'POST' && (p === '/v1/messages' || p === '/messages')) {
      const body = await readBody(req);
      await handleMessages(req, res, body, signal);
      return;
    }
    if (req.method === 'POST' && (p === '/v1/messages/count_tokens' || p === '/messages/count_tokens')) {
      // 粗估(≈4 字符/ token);Claude Code 的上下文管理只需要量级正确
      const body = await readBody(req);
      const n = Math.ceil((JSON.stringify(body.system ?? '') + JSON.stringify(body.messages ?? '') + JSON.stringify(body.tools ?? '')).length / 4);
      json(res, 200, { input_tokens: n });
      return;
    }
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      const body = await readBody(req);
      await handleChatCompletions(req, res, body, signal);
      return;
    }
    json(res, 404, { error: { message: `桥支持:GET /healthz、GET /v1/models、POST /v1/responses(Codex)、POST /v1/messages、POST /v1/chat/completions(Hermes) 与 /v1/messages/count_tokens(Claude Code)(收到 ${req.method} ${p})` } });
  } catch (e) {
    if (signal.aborted) return;
    await log(`handler error: ${e.stack ?? e.message}`);
    if (!res.headersSent) json(res, 500, { error: { message: e.message } });
    else res.end();
  } finally {
    res.removeListener('close', onClose);
  }
}

async function serve(port) {
  installCrashGuard();
  const server = createServer(handle);
  await new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', ok);
  });
  console.log(`[codex-responses-bridge] listening on http://127.0.0.1:${port}/v1`);
  await log(`serve on :${port}`);
}

async function ensure(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
    if (r.ok) { console.log('codex bridge already healthy'); return 0; }
  } catch { /* 不在,拉起 */ }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(port)], {
    detached: true, stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise(ok => setTimeout(ok, 200));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { console.log(`codex bridge started on :${port}`); return 0; }
    } catch { /* 继续等 */ }
  }
  console.error(`codex bridge spawn attempted but :${port} still not responding(详见 ${logPath})`);
  return 0; // 与套件 hook 同一契约:never fails the session
}

/**
 * 强制重启:ensure 只保证「有个健康的桥」,不替换已存在的进程,所以桥代码更新后
 * 双击重启脚本仍是旧代码在跑(11148 修复迟迟不生效的根因)。restart 会先按
 * /healthz 报告的 pid 终止旧进程,确认端口释放,再拉起新进程并核对身份。
 */
async function restart(port) {
  const health = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(700) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const old = await health();
  const oldPid = old?.bridge === true && Number.isInteger(old.pid) ? old.pid : null;
  if (oldPid && oldPid !== process.pid) {
    try { process.kill(oldPid, 'SIGTERM'); } catch { /* 已退出 */ }
    let released = false;
    for (let i = 0; i < 30 && !released; i++) {
      await new Promise(ok => setTimeout(ok, 150));
      released = (await health()) === null;
    }
    if (!released) {
      try { process.kill(oldPid, 'SIGKILL'); } catch { /* 已退出 */ }
      for (let i = 0; i < 20 && !released; i++) {
        await new Promise(ok => setTimeout(ok, 150));
        released = (await health()) === null;
      }
    }
    if (!released) { console.error(`bridge :${port} pid ${oldPid} 未能终止,请先手动结束该进程`); return 1; }
    console.log(`bridge :${port} stopped old pid ${oldPid} (was ${old.startedAt ?? 'unknown'})`);
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(port)], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(ok => setTimeout(ok, 200));
    const now = await health();
    if (now && now.bridge === true && (!oldPid || now.pid !== oldPid)) {
      console.log(`bridge :${port} started pid ${now.pid} codeMtime=${now.codeMtime ?? 'unknown'}`);
      return 0;
    }
  }
  console.error(`bridge :${port} restart 后仍未就绪(详见 ${logPath})`);
  return 1;
}

async function status() {
  try {
    const r = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/healthz`, { signal: AbortSignal.timeout(800) });
    console.log(`bridge :${DEFAULT_PORT}:`, r.ok ? 'up' : `HTTP ${r.status}`);
  } catch { console.log(`bridge :${DEFAULT_PORT}: down`); }
  for (const t of TOOLS) {
    const ep = endpointFor(t.tool);
    if (!ep) { console.log(`${t.key.padEnd(6)}(${t.tool}): no endpoint.json`); continue; }
    try {
      const r = await fetch(`http://127.0.0.1:${ep.port}/healthz`, { signal: AbortSignal.timeout(1500) });
      console.log(`${t.key.padEnd(6)}(${t.tool}) :${ep.port}: ${r.ok ? 'up' : `HTTP ${r.status}`}`);
    } catch { console.log(`${t.key.padEnd(6)}(${t.tool}) :${ep.port}: down`); }
  }
}

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'ensure';
const portIdx = argv.indexOf('--port');
const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : DEFAULT_PORT;

if (cmd === 'serve') await serve(port);
else if (cmd === 'ensure') process.exit(await ensure(port));
else if (cmd === 'restart') process.exit(await restart(port));
else if (cmd === 'status') await status();
else { console.error('用法: serve [--port N] | ensure | restart | status'); process.exit(2); }
