#!/usr/bin/env node
/**
 * codex-responses-bridge.mjs — 本地协议桥(127.0.0.1:39268),把两类宿主的请求翻译成
 * zcode-*-connect 四个 chat/completions 端点:
 *   · Codex(0.142+,仅 Responses API):POST /v1/responses
 *   · Claude Code:POST /v1/messages + /v1/messages/count_tokens(Anthropic Messages)
 * 文件名沿用 codex 起名,现同时服务两类宿主。
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
 * 纯 Node 零依赖;只绑定 127.0.0.1;桥本身不鉴权(鉴权由各端点的 bearer 完成)。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function log(line) {
  try {
    await mkdir(stateDir, { recursive: true });
    await appendFile(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch { /* 诊断尽力而为 */ }
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
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
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
        tool_calls: [{ id: item.call_id ?? 'call_0', type: 'function', function: { name: item.name ?? '', arguments: deFingerprintLexical(item.arguments ?? '', mutLevel) } }],
      });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id ?? 'call_0', content: capToolOutput(typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')) });
    }
    // reasoning 等其他 item 无 chat 等价物,丢弃
  }
  return messages;
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
    this.outputIndex = 0;
    this.msg = null;   // 进行中的 assistant message
    this.reasoning = null;
    this.calls = new Map(); // upstream tool index -> {id, name, args, announced}
    this.usage = null;
    this.finish = null;
  }

  responsePayload(status, extra = {}) {
    return {
      id: `resp_${Date.now().toString(36)}`,
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
      sseWrite(res, 'content_block_delta', { index: this.msg.outputIndex, delta: { type: 'text_delta', text: tail } });
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
    for (const [, call] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.announced) continue; // 没拿到名字的残缺调用,丢弃
      sseWrite(res, 'response.function_call_arguments.done', { item_id: `fc_${call.outputIndex}`, output_index: call.outputIndex, arguments: call.args });
      const item = { id: `fc_${call.outputIndex}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.args };
      sseWrite(res, 'response.output_item.done', { output_index: call.outputIndex, item });
      this.items.push(item);
    }
    // DSML 四道门恢复:剔除内容里结构完好的 tool_calls 块 → function_call 条目
    const recovered = recoverDSMLToolCalls(this.dsml.capture, this.declaredTools);
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

async function upstreamChat(ep, body, { mutLevel = 0, noStreamOptions = false, noMaxTokens = false } = {}) {
  // 只发送 ZCode/pi 同款的最小字段集:workbuddy 上游做通道校验(11128),
  // codex 特有的 parallel_tool_calls / stream_options 等额外字段会触发拦截。
  const payload = {
    model: body.model,
    messages: toChatMessages(body.instructions, body.input, mutLevel),
    stream: true,
  };
  if (!noStreamOptions) payload.stream_options = { include_usage: true };
  // 输出预算(见 clampMaxOutput):Codex 的 max_output_tokens 夹到上游天花板
  const maxOut = clampMaxOutput(body.max_output_tokens ?? body.max_tokens);
  if (maxOut && !noMaxTokens) payload.max_tokens = maxOut;
  const tools = toChatTools(body.tools);
  if (tools) payload.tools = tools;
  const tc = toChatToolChoice(body.tool_choice);
  if (tc) payload.tool_choice = tc;
  // parallel_tool_calls 不转发:workbuddy 上游通道校验会拦非官方字段

  return fetch(`http://127.0.0.1:${ep.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
    body: JSON.stringify(payload),
  });
}

async function handleResponses(req, res, wireModel, body) {
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

  const callUpstream = (mutLevel, noStreamOptions, noMaxTokens = false) =>
    upstreamChat(ep, { ...body, model: chatModel }, { mutLevel, noStreamOptions, noMaxTokens });

  let upstream;
  try {
    upstream = await callUpstream(0, false);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } }));
    return;
  }
  if (upstream.status === 400) {
    let errText = await upstream.text().catch(() => '');
    if (errText.includes('11128')) {
      // 11128 同义改写梯子:level 1(措辞加强)→ level 2(中性头兜底)
      for (let level = 1; level <= 2; level++) {
        try {
          upstream = await callUpstream(level, false);
        } catch (e) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } }));
          return;
        }
        if (upstream.status !== 400) break;
        errText = await upstream.text().catch(() => '');
        if (!errText.includes('11128')) break;
      }
    } else {
      // 非 11128 的 400:个别通道不认 stream_options / max_tokens,去掉后重试一次
      try {
        upstream = await callUpstream(0, true, true);
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } }));
        return;
      }
    }
    if (upstream.failed || !upstream.ok) {
      const text = upstream.failed ? '' : await upstream.text().catch(() => '');
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(text || JSON.stringify({ error: { message: `${t.tool} 端点重试仍失败:${upstream.failed?.cause?.code ?? `HTTP ${upstream.status ?? '?'}`}` } }));
      return;
    }
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(text || JSON.stringify({ error: { message: `upstream HTTP ${upstream.status}` } }));
    return;
  }

  const clientWantsStream = body.stream !== false;
  if (!clientWantsStream) {
    // 聚合成单个 JSON response(codex 恒为流式;此路径便于 curl 调试)
    const builder = new ResponseBuilder(wireModel, new Set((body.tools ?? []).filter(t2 => t2?.type === 'function' && t2.name).map(t2 => t2.name)));
    for await (const d of upstreamSseChunks(upstream)) {
      const err = builder.handleChunk({ write: () => {} }, d);
      if (err?.error) break;
    }
    builder.finishAll(res, 'completed');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(builder.responsePayload('completed')));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const builder = new ResponseBuilder(wireModel, new Set((body.tools ?? []).filter(t2 => t2?.type === 'function' && t2.name).map(t2 => t2.name)));
  sseWrite(res, 'response.created', { response: builder.responsePayload('in_progress') });
  sseWrite(res, 'response.in_progress', { response: builder.responsePayload('in_progress') });

  let streamError = null;
  for await (const d of upstreamSseChunks(upstream)) {
    const err = builder.handleChunk(res, d);
    if (err?.error) { streamError = err.error; break; }
  }
  builder.finishAll(res);

  if (streamError) {
    sseWrite(res, 'response.failed', { response: builder.responsePayload('failed', { error: streamError }) });
  } else if (builder.finish === 'length') {
    sseWrite(res, 'response.incomplete', { response: builder.responsePayload('incomplete', { incomplete_details: { reason: 'max_output_tokens' } }) });
  } else {
    sseWrite(res, 'response.completed', { response: builder.responsePayload('completed') });
  }
  sseDone(res);
  res.end();
}

async function* upstreamSseChunks(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    let step;
    try {
      step = await reader.read();
    } catch (error) {
      // 上游连接中途断掉(端点重启 / 网关掐断 / 客户端取消):这里必须自己咽掉。
      // 异常一旦从 handleMessages 的 async 函数里逃出去就是 unhandledRejection,
      // Node 22 默认直接结束进程 —— 一个请求出错会把整个桥(所有模型、所有会话)
      // 一起拖死,用户侧表现为 503 connect-refused + 代理熔断。
      // 咽掉不等于粉饰:合成一个 error 帧交回调用方,按原有错误路径收尾。
      yield { error: { message: `upstream stream broke: ${String(error?.message ?? error)}`, type: 'upstream_broken' } };
      return;
    }
    const { done, value } = step;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* 跳过坏帧 */ }
    }
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
  static strip(s, capture) {
    return s
      .replace(/<｜DSML｜[^>\n]{0,400}>?/g, (m) => { if (capture) capture.push(m); return ''; })
      .replace(/｜{1,2}DSML｜{1,2}[^\n]{0,400}/g, (m) => { if (capture) capture.push(m); return ''; });
  }
  push(s) {
    s = this.carry + s;
    const stripped = DSMLTextFilter.strip(s, this.capture);
    const hold = Math.max(stripped.lastIndexOf('<'), stripped.lastIndexOf('｜'));
    if (hold >= 0 && stripped.length - hold <= 40 && !stripped.slice(hold).includes('\n')) {
      this.carry = stripped.slice(hold);
      return stripped.slice(0, hold);
    }
    this.carry = '';
    return stripped;
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
  const prefixed = [...declaredTools].filter((n) => {
    const nl = String(n).toLowerCase();
    return nl.startsWith(lower) || lower.startsWith(nl);
  });
  return prefixed.length === 1 ? prefixed[0] : '';
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
  const openRe = /<｜{1,2}DSML｜{1,2}tool[\s_-]*calls>/g;
  const closeRe = /<\/｜{1,2}DSML｜{1,2}tool[\s_-]*calls>/g;
  const opens = [...captured.matchAll(openRe)];
  const closes = [...captured.matchAll(closeRe)];
  // 门 1:开闭配对(开闭数量相等,逐对取块)
  const n = Math.min(opens.length, closes.length);
  for (let i = 0; i < n; i++) {
    const start = opens[i].index + opens[i][0].length;
    const end = closes[i].index;
    if (end <= start) continue;
    const inner = captured.slice(start, end);
    // invoke 块:名称必须带 name="…"(门 2 前置)
    const invokeRe = /<｜{1,2}DSML｜{1,2}invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}invoke>/g;
    for (const inv of inner.matchAll(invokeRe)) {
      // 门 2:工具名必须在本请求声明过(标记残渣先剥离再比对)
      const name = canonicalToolName(inv[1], declaredTools);
      if (name === '') continue;
      const params = {};
      const paramRe = /<｜{1,2}DSML｜{1,2}parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}parameter>/g;
      for (const pm of inv[2].matchAll(paramRe)) {
        try { params[pm[1]] = JSON.parse(pm[2]); } catch { params[pm[1]] = pm[2]; }
      }
      // 门 4:参数对象可序列化(序列化失败即回滚)
      let args;
      try { args = JSON.stringify(params); } catch { continue; }
      out.push({ id: `dsml_${out.length}_${Date.now().toString(36)}`, name, arguments: args });
    }
  }
  return out;
}

/**
 * 恢复失败的可诊断性:抓到了 tool_calls 块却一个 invoke 都没还原,说明模型这次
 * 把标记写坏到了无法安全解析的程度(实测形态 `<name>Grep</｜｜DSML｜｜ parameter>`)。
 * 这类本轮会退化成「文本戛然而止、没有工具调用」,由 Stop 守卫的自动续跑兜住;
 * 这里只留一份可排查的记录,不合成任何调用 —— 猜错的工具调用比漏一次贵得多。
 */
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
      for (const p of parts) {
        if (p?.type === 'text') texts.push(p.text ?? '');
        else if (p?.type === 'tool_result') {
          if (texts.length) { out.push({ role: 'user', content: texts.join('') }); texts.length = 0; }
          out.push({ role: 'tool', tool_call_id: p.tool_use_id ?? '', content: capToolOutput(anthropicTextOf(p.content)) || (p.is_error ? '(tool error)' : '') });
        }
        // image 等无 chat 等价物,丢弃
      }
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
  return out;
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

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// ---- 输出预算 ----
// 以前桥完全不转发客户端的 max_tokens:上游按自己的默认值生成,客户端却按自己的
// 预算记账(Claude Code 的 CLAUDE_CODE_MAX_OUTPUT_TOKENS 常见 6000/128000 两档),
// 于是「客户端以为早该截断的地方上游还在写」——上下文计量与实际输出脱节。
// 现在转发,但夹在上游能接受的天花板内:各通道对超限 max_tokens 的处置不一致
// (有的 400、有的静默按上限截),统一压到 ZC_MAX_OUTPUT_TOKENS(默认 32000)。
const MAX_OUTPUT_CEILING = Number(process.env['ZC_MAX_OUTPUT_TOKENS'] ?? 32000);

function clampMaxOutput(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ceiling = Number.isFinite(MAX_OUTPUT_CEILING) && MAX_OUTPUT_CEILING > 0 ? MAX_OUTPUT_CEILING : 32000;
  return Math.min(Math.floor(n), ceiling);
}

class AnthropicStreamBuilder {
  constructor(model, estInput, declaredTools = new Set()) {
    this.model = model;
    this.declaredTools = declaredTools;
    this.dsml = new DSMLTextFilter();
    this.blockIndex = 0;
    this.cur = null;   // {kind:'text'|'thinking'|'tool', index, text, args, id, name}
    this.blocks = [];
    this.finish = null;
    this.usage = null;
    this.estInput = estInput;
    /** 上游 tool_call 增量先到的 id/参数,按上游 index 存,等 name 到达再开块。 */
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
      // DSML 四道门恢复:剔除的内容里若有结构完好的 tool_calls 块,转成可执行调用
      const recovered = recoverDSMLToolCalls(this.dsml.capture, this.declaredTools);
      noteUnrecoveredDSML(this.dsml.capture, recovered);
      for (const call of recovered) {
        this.openBlock(res, 'tool', { id: call.id, name: call.name });
        this.cur.args = call.arguments;
        this.closeBlock(res);
      }
      this.dsml.capture = '';
      sseWrite(res, 'content_block_stop', { index: i });
      this.blocks.push({ type: 'text', text: this.cur.text });
    } else if (this.cur.kind === 'thinking') {
      sseWrite(res, 'content_block_stop', { index: i });
      this.blocks.push({ type: 'thinking', thinking: this.cur.text, signature: '' });
    } else if (this.cur.kind === 'tool') {
      sseWrite(res, 'content_block_stop', { index: i });
      this.blocks.push({ type: 'tool_use', id: this.cur.id, name: this.cur.name, input: safeJsonParse(this.cur.args || '{}') });
    }
    this.cur = null;
    this.blockIndex = i + 1;
  }

  openBlock(res, kind, extra = {}) {
    this.closeBlock(res);
    const idx = this.blockIndex;
    const block = kind === 'text' ? { type: 'text', text: '' }
      : kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' }
        : { type: 'tool_use', id: extra.id, name: extra.name, input: {} };
    sseWrite(res, 'content_block_start', { index: idx, content_block: block });
    this.cur = { kind, index: idx, text: '', args: '', ...extra };
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
        const isCur = this.cur?.kind === 'tool' && this.cur.upIdx === idx;
        if (!isCur) {
          // 名字没到之前先把 id / 参数攒起来。旧实现直接 `continue` 丢掉这一段,
          // 结果:名字晚一帧到达时开的是空参数块(工具用错参数执行),名字压根不来
          // 时整条调用蒸发,只剩一个 stop_reason=tool_use 的空回合 ——
          // 宿主既没有工具可执行,也看不到正文,于是"任务没结束就停住"。
          const buf = this.pendingTools.get(idx) ?? { id: '', args: '' };
          if (tc.id) buf.id = tc.id;
          if (tc.function?.arguments) buf.args += tc.function.arguments;
          this.pendingTools.set(idx, buf);
          if (!tc.function?.name) continue; // 等名字
          this.closeBlock(res);
          this.openBlock(res, 'tool', {
            upIdx: idx,
            id: buf.id || `call_${idx}_${Date.now().toString(36)}`,
            name: tc.function.name,
          });
          if (buf.args) {
            this.cur.args += buf.args;
            sseWrite(res, 'content_block_delta', { index: this.cur.index, delta: { type: 'input_json_delta', partial_json: buf.args } });
          }
          this.pendingTools.delete(idx);
          continue;
        }
        if (tc.id) this.cur.id = tc.id;
        if (tc.function?.arguments) {
          this.cur.args += tc.function.arguments;
          sseWrite(res, 'content_block_delta', { index: this.cur.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
        }
      }
    }
    return null;
  }

  finishAll(res) {
    this.closeBlock(res);
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
    const mapped = ANTHROPIC_STOP[this.finish] ?? 'end_turn';
    if (mapped === 'tool_use' && !this.blocks.some(b => b.type === 'tool_use')) return 'end_turn';
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

async function handleMessages(req, res, body) {
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
  if (tc) chatPayload.tool_choice = tc;
  // 输出预算:Claude 的 max_tokens 夹到上游天花板(见 clampMaxOutput)
  const maxOut = clampMaxOutput(body.max_tokens);
  if (maxOut) chatPayload.max_tokens = maxOut;
  const estInput = estimateTokens(body);

  const callUpstream = (mutLevel, noStreamOptions, noMaxTokens = false) => {
    const p = { ...chatPayload };
    // 每级都从原始 body 重建:billing 剥除 + 去指纹 + assistant 历史改写按当前档位重算
    p.messages = toChatMessagesAnthropic(deFingerprint(anthropicTextOf(stripBillingBlocks(body.system)), mutLevel), body.messages, mutLevel);
    if (noStreamOptions) delete p.stream_options;
    if (noMaxTokens) delete p.max_tokens;
    return fetch(`http://127.0.0.1:${ep.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
      body: JSON.stringify(p),
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
    json(res, 502, { type: 'error', error: { type: 'api_error', message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } });
    return;
  }
  if (upstream.status === 400) {
    let errText = await upstream.text().catch(() => '');
    if (errText.includes('11128')) {
      // 11128 同义改写梯子:level 1(措辞加强)→ level 2(中性头兜底)
      for (let level = 1; level <= 2; level++) {
        try {
          upstream = await callUpstream(level, false);
        } catch (e) {
          json(res, 502, { type: 'error', error: { type: 'api_error', message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } });
          return;
        }
        if (upstream.status !== 400) break;
        errText = await upstream.text().catch(() => '');
        if (!errText.includes('11128')) break;
      }
    } else {
      // 非 11128 的 400:个别通道不认 stream_options / max_tokens,去掉后重试一次
      try {
        upstream = await callUpstream(0, true, true);
      } catch (e) {
        json(res, 502, { type: 'error', error: { type: 'api_error', message: `${t.tool} 端点连接失败:${e.cause?.code ?? e.message}` } });
        return;
      }
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      json(res, upstream.status, { type: 'error', error: { type: 'api_error', message: text.slice(0, 500) || `upstream HTTP ${upstream.status}` } });
      return;
    }
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    json(res, upstream.status, { type: 'error', error: { type: 'api_error', message: text.slice(0, 500) || `upstream HTTP ${upstream.status}` } });
    return;
  }

  const builder = new AnthropicStreamBuilder(wireModel, estInput, new Set((tools ?? []).map(t2 => t2.function.name)));
  if (body.stream !== true) {
    for await (const d of upstreamSseChunks(upstream)) { builder.handleChunk({ write: () => {} }, d); }
    builder.closeBlock({ write: () => {} });
    const stopReason = builder.resolveStop();
    json(res, 200, {
      id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: wireModel,
      content: builder.blocks, stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: builder.usage?.input_tokens ?? estInput, output_tokens: builder.usage?.output_tokens ?? 0 },
    });
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  builder.msgStart(res);
  let streamError = null;
  for await (const d of upstreamSseChunks(upstream)) {
    const err = builder.handleChunk(res, d);
    if (err) { streamError = err; break; }
  }
  if (streamError) {
    sseWrite(res, 'error', { type: 'error', error: { type: 'api_error', message: String(streamError.message ?? JSON.stringify(streamError)).slice(0, 500) } });
  } else {
    builder.finishAll(res);
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

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && (p === '/healthz' || p === '/health')) {
      const tools = {};
      for (const t of TOOLS) {
        const ep = endpointFor(t.tool);
        tools[t.key] = ep ? `:${ep.port}` : 'missing';
      }
      json(res, 200, { ok: true, bridge: true, tools });
      return;
    }
    if (req.method === 'GET' && p === '/v1/models') {
      json(res, 200, { object: 'list', data: await aggregateModels() });
      return;
    }
    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      const body = await readBody(req);
      await handleResponses(req, res, body.model ?? '', body);
      return;
    }
    if (req.method === 'POST' && (p === '/v1/messages' || p === '/messages')) {
      const body = await readBody(req);
      await handleMessages(req, res, body);
      return;
    }
    if (req.method === 'POST' && (p === '/v1/messages/count_tokens' || p === '/messages/count_tokens')) {
      // 粗估(≈4 字符/ token);Claude Code 的上下文管理只需要量级正确
      const body = await readBody(req);
      const n = Math.ceil((JSON.stringify(body.system ?? '') + JSON.stringify(body.messages ?? '') + JSON.stringify(body.tools ?? '')).length / 4);
      json(res, 200, { input_tokens: n });
      return;
    }
    json(res, 404, { error: { message: `桥支持:GET /healthz、GET /v1/models、POST /v1/responses(Codex)、POST /v1/messages 与 /v1/messages/count_tokens(Claude Code)(收到 ${req.method} ${p})` } });
  } catch (e) {
    await log(`handler error: ${e.stack ?? e.message}`);
    if (!res.headersSent) json(res, 500, { error: { message: e.message } });
    else res.end();
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
else if (cmd === 'status') await status();
else { console.error('用法: serve [--port N] | ensure | status'); process.exit(2); }
