// 上游 11148 "tool calls and tool results do not match" 回归。
//
// WorkBuddy 上游要求:每条 assistant.tool_calls 之后紧跟等量、ID 一一对应的
// role:tool 消息。Codex 每轮重发完整 input,一旦某轮工具调用被中断 / 并行调用被
// 拆条,残缺历史会毒化到会话结束(上游 retry:false,只能开新会话)。
// 这里验证桥在出站前把结构修成合法形态,且不破坏正常多轮。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createContext, Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hostIsLoopback, originIsLoopback } from '../zcode-trae-connect/src/loopback.js';
import { detectStall, CONTINUE_PROMPT } from '../shared/stall-detector.mjs';

const bridgeUrl = new URL('../scripts/codex-responses-bridge.mjs', import.meta.url);
const source = readFileSync(bridgeUrl, 'utf8');
const runnable = source.slice(0, source.indexOf('const argv = process.argv.slice(2);'))
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(bridgeUrl.href));

let handler;
let calls = [];
const context = createContext({
  path, fileURLToPath, Buffer, TextDecoder, URL, AbortController, AbortSignal, console,
  hostIsLoopback, originIsLoopback, detectStall, CONTINUE_PROMPT,
  process: { env: {}, on() {} },
  os: { homedir: () => '/synthetic-home' },
  fs: { readFileSync: () => JSON.stringify({ port: 1, token: 'synthetic-token' }) },
  mkdir: async () => {}, appendFile: async () => {},
  createServer(callback) {
    handler = callback;
    return { once() {}, listen(_port, _host, ready) { ready(); } };
  },
  fetch: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const chunk = { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  },
});
new Script(`${runnable}
globalThis.testExports = { repairToolPairing, toChatMessages, toChatMessagesAnthropic };
globalThis.startBridge = serve;`, { filename: fileURLToPath(bridgeUrl) }).runInContext(context);
await context.startBridge(39268);
const { repairToolPairing, toChatMessages, toChatMessagesAnthropic } = context.testExports;

// VM realm 的对象跨 realm 无法直接 deepEqual,统一序列化回主 realm
const plain = (v) => JSON.parse(JSON.stringify(v));

const fc = (id, name, args = '{}') => ({ type: 'function_call', call_id: id, name, arguments: args });
const fco = (id, output = 'ok') => ({ type: 'function_call_output', call_id: id, output });
const umsg = (content) => ({ role: 'user', content });
const tc = (id, name = 'Bash') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const assistantCalls = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const tool = (id, content = 'ok') => ({ role: 'tool', tool_call_id: id, content });

/** 模拟上游 11148 校验:调用块后必须紧跟等量、ID 一一对应的 tool 消息。 */
function assertPaired(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') assert.fail(`orphan tool result at ${i}`);
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    const ids = m.tool_calls.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, 'tool_call ids must be unique');
    const following = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') { following.push(messages[j].tool_call_id); j++; }
    assert.deepEqual(following, ids, 'tool results must immediately follow, in tool_calls order');
    i = j - 1;
  }
}

let passed = 0;
let failed = 0;
async function test(label, run) {
  try { await run(); console.log(`ok ${++passed}. ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.message}`); }
}

// ---- repairToolPairing: 纯结构修复 ----
await test('P1 parallel calls merged into one assistant + ordered results', () => {
  const out = plain(repairToolPairing([
    umsg('hi'), assistantCalls(tc('c1')), assistantCalls(tc('c2', 'Read')),
    tool('c1', 'A'), tool('c2', 'B'), umsg('go'),
  ]));
  assert.equal(out.length, 5);
  assert.equal(out[1].tool_calls.length, 2);
  assert.deepEqual(out.slice(2, 4).map((m) => m.content), ['A', 'B']);
  assert.equal(out[4].content, 'go');
  assertPaired(out);
});

await test('P2 orphan tool_call gets placeholder result (interrupted tool turn)', () => {
  const out = plain(repairToolPairing([umsg('hi'), assistantCalls(tc('c1')), umsg('go')]));
  assert.equal(out.length, 4);
  assert.equal(out[2].role, 'tool');
  assert.equal(out[2].tool_call_id, 'c1');
  assert.match(out[2].content, /interrupted/);
  assert.equal(out[3].content, 'go');
  assertPaired(out);
});

await test('P3 orphan tool result dropped (no preceding call block)', () => {
  const out = plain(repairToolPairing([umsg('hi'), tool('ghost', 'x'), umsg('go')]));
  assert.deepEqual(out.map((m) => m.role), ['user', 'user']);
  assert.deepEqual(out.map((m) => m.content), ['hi', 'go']);
  assertPaired(out);
});

await test('P4 duplicate call ids are made unique and still paired', () => {
  const out = plain(repairToolPairing([
    umsg('hi'), assistantCalls(tc('dup'), tc('dup', 'Read')), tool('dup', 'A'), umsg('go'),
  ]));
  const ids = out[1].tool_calls.map((c) => c.id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(out.slice(2, 4).map((m) => m.tool_call_id), ids);
  assert.equal(out[2].content, 'A', 'first call keeps its real result');
  assert.match(out[3].content, /interrupted/, 'second (renamed) call gets a placeholder');
  assert.equal(out[4].content, 'go');
  assertPaired(out);
});

await test('P5 well-formed 1 call + 1 result passes through unchanged', () => {
  const input = [umsg('hi'), assistantCalls(tc('c1')), tool('c1', 'A'), umsg('go')];
  assert.deepEqual(plain(repairToolPairing(input)), input);
  assertPaired(plain(repairToolPairing(input)));
});

await test('P6 no tools at all: untouched', () => {
  const input = [umsg('a'), { role: 'assistant', content: 'b' }, umsg('c')];
  assert.deepEqual(plain(repairToolPairing(input)), input);
});

// ---- Responses 路径: Codex input -> chat messages ----
await test('P7 Codex parallel function_calls produce one merged call block', () => {
  const out = plain(toChatMessages('', [
    umsg('hi'), fc('c1', 'Bash'), fc('c2', 'Read'), fco('c1', 'A'), fco('c2', 'B'), umsg('go'),
  ]));
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(out[1].tool_calls.length, 2);
  assert.deepEqual(out.slice(2, 4).map((m) => m.content), ['A', 'B']);
  assertPaired(out);
});

await test('P8 Codex interrupted tool turn is repaired before upstream sees it', () => {
  const out = plain(toChatMessages('', [umsg('hi'), fc('c1', 'Bash'), umsg('go')]));
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.match(out[2].content, /interrupted/);
  assertPaired(out);
});

await test('P9 missing call_id no longer collapses to shared call_0', () => {
  const out = plain(toChatMessages('', [
    umsg('hi'),
    { type: 'function_call', name: 'Bash', arguments: '{}' },
    { type: 'function_call', name: 'Read', arguments: '{}' },
    umsg('go'),
  ]));
  const ids = out[1].tool_calls.map((c) => c.id);
  assert.equal(new Set(ids).size, 2);
  assertPaired(out);
});

// ---- Messages 路径: Claude tool_result + text 混合 ----
await test('P10 Claude tool_result goes before user text, adjacent to tool_calls', () => {
  const out = plain(toChatMessagesAnthropic('', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'x' } }] },
    { role: 'user', content: [
      { type: 'text', text: '说明' },
      { type: 'tool_result', tool_use_id: 't1', content: 'done' },
    ] },
  ]));
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(out[2].content, 'done');
  assert.equal(out[3].content, '说明');
  assertPaired(out);
});

await test('P11 Claude interrupted tool_use gets placeholder result', () => {
  const out = plain(toChatMessagesAnthropic('', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    { role: 'user', content: 'go' },
  ]));
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.match(out[2].content, /interrupted/);
  assertPaired(out);
});

// ---- 集成:确认出站 payload 真的带修复后的 messages ----
async function post(route, body) {
  new Script('epCache.clear()').runInContext(context);
  calls = [];
  const socket = new Duplex({ read() {}, write(_data, _encoding, done) { done(); } });
  const req = new IncomingMessage(socket);
  req.method = 'POST';
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.complete = true;
  req.url = `/v1/${route}`;
  req.headers = { host: '127.0.0.1:39268', 'content-type': 'application/json' };
  req.push(JSON.stringify({ model: 'wb/test', stream: false, ...body }));
  req.push(null);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  const output = [];
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (data, ...rest) => { output.push(Buffer.from(data)); return write(data, ...rest); };
  res.end = (data, ...rest) => { if (data) output.push(Buffer.from(data)); return end(data, ...rest); };
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  try {
    await handler(req, res);
    await finished;
    return { status: res.statusCode, body: output.length ? Buffer.concat(output).toString('utf8') : '' };
  } finally { socket.destroy(); }
}

await test('P12 /v1/responses wire payload is 11148-safe for parallel calls', async () => {
  const r = await post('responses', {
    input: [umsg('hi'), fc('c1', 'Bash'), fc('c2', 'Read'), fco('c1', 'A'), fco('c2', 'B'), umsg('go')],
  });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assertPaired(calls[0].messages);
  assert.equal(calls[0].messages[1].tool_calls.length, 2);
});

await test('P13 /v1/responses wire payload is 11148-safe for interrupted call', async () => {
  const r = await post('responses', { input: [umsg('hi'), fc('c1', 'Bash'), umsg('go')] });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assertPaired(calls[0].messages);
  assert.match(calls[0].messages[2].content, /interrupted/);
});

console.log(failed === 0 ? `\nbridge tool pairing: ${passed} passed, 0 failed` : `\nbridge tool pairing: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
