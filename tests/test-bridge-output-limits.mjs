// 输出预算:按模型真实 max_output_tokens 夹取,不再一律压到 32000。
// 旧行为让 wb/hy4free(64000)、wb/deepseek-v4.1-flash(128000) 被无谓砍半,
// 单轮稍长就 finish_reason:"length" -> Codex "Incomplete response returned"。
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

const LIMITS = {
  'wb/auto': 32000,
  'wb/hy4free': 64000,
  'wb/deepseek-v4.1-flash': 128000,
  'wb/glm-5.3-flash': 131072,
  'trae/glm-5.3': 32000,
  'qw/qwen3.8-flash': 32000,
};

let handler;
let calls = [];
let env = {};
const context = createContext({
  path, fileURLToPath, Buffer, TextDecoder, URL, AbortController, AbortSignal, console,
  hostIsLoopback, originIsLoopback, detectStall, CONTINUE_PROMPT,
  process: { env, pid: 424242, on() {} },
  os: { homedir: () => '/synthetic-home' },
  fs: {
    readFileSync: (p) => String(p).includes('model-output-limits.json')
      ? JSON.stringify({ limits: LIMITS })
      : JSON.stringify({ port: 1, token: 'synthetic-token' }),
    statSync: () => ({ mtime: new Date('2026-11-05T00:00:00.000Z') }),
  },
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
globalThis.testExports = { outputCapFor, clampMaxOutput };
globalThis.startBridge = serve;`, { filename: fileURLToPath(bridgeUrl) }).runInContext(context);
await context.startBridge(39268);
const { outputCapFor, clampMaxOutput } = context.testExports;

let passed = 0;
let failed = 0;
async function test(label, run) {
  try { await run(); console.log(`ok ${++passed}. ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.message}`); }
}

// ---- 表驱动的上限 ----
await test('O1 real limit per model, no global 32000 clamp', () => {
  assert.equal(outputCapFor('wb/hy4free'), 64000);
  assert.equal(outputCapFor('wb/deepseek-v4.1-flash'), 128000);
  assert.equal(outputCapFor('wb/glm-5.3-flash'), 131072);
  assert.equal(outputCapFor('trae/glm-5.3'), 32000);
});

await test('O2 unknown model falls back to 32000', () => {
  assert.equal(outputCapFor('qoder/glm-5.3'), 32000);
  assert.equal(outputCapFor('wb/unlisted'), 32000);
});

await test('O3 clamp keeps client value when below model cap', () => {
  assert.equal(clampMaxOutput(6000, 'wb/hy4free'), 6000);
  assert.equal(clampMaxOutput(32000, 'wb/deepseek-v4.1-flash'), 32000);
});

await test('O4 clamp caps client value at model cap', () => {
  assert.equal(clampMaxOutput(200000, 'wb/hy4free'), 64000);
  assert.equal(clampMaxOutput(200000, 'wb/deepseek-v4.1-flash'), 128000);
  assert.equal(clampMaxOutput(200000, 'trae/glm-5.3'), 32000);
});

await test('O5 missing/invalid budget stays 0 (do not forward)', () => {
  assert.equal(clampMaxOutput(undefined, 'wb/hy4free'), 0);
  assert.equal(clampMaxOutput(0, 'wb/hy4free'), 0);
  assert.equal(clampMaxOutput('abc', 'wb/hy4free'), 0);
});

await test('O6 ZC_MAX_OUTPUT_TOKENS overrides everything', () => {
  env.ZC_MAX_OUTPUT_TOKENS = '8000';
  try {
    assert.equal(outputCapFor('wb/deepseek-v4.1-flash'), 8000);
    assert.equal(clampMaxOutput(128000, 'wb/deepseek-v4.1-flash'), 8000);
  } finally { delete env.ZC_MAX_OUTPUT_TOKENS; }
  assert.equal(outputCapFor('wb/deepseek-v4.1-flash'), 128000);
});

// ---- 集成:出站 payload 的 max_tokens ----
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
  req.push(JSON.stringify({ stream: false, ...body }));
  req.push(null);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  const output = [];
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (data, ...rest) => { output.push(Buffer.from(data)); return write(data, ...rest); };
  res.end = (data, ...rest) => { if (data) output.push(Buffer.from(data)); return end(data, ...rest); };
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  try { await handler(req, res); await finished; return { status: res.statusCode }; }
  finally { socket.destroy(); }
}

await test('O7 /v1/responses forwards 64000 for wb/hy4free (old code sent 32000)', async () => {
  const r = await post('responses', { model: 'wb/hy4free', input: 'hi', max_output_tokens: 64000 });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].max_tokens, 64000);
});

await test('O8 /v1/responses caps oversized budget at model limit', async () => {
  const r = await post('responses', { model: 'wb/deepseek-v4.1-flash', input: 'hi', max_output_tokens: 200000 });
  assert.equal(r.status, 200);
  assert.equal(calls[0].max_tokens, 128000);
});

await test('O9 /v1/messages uses its own model limit', async () => {
  const r = await post('messages', {
    model: 'wb/deepseek-v4.1-flash', max_tokens: 200000,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.status, 200);
  assert.equal(calls[0].max_tokens, 128000);
});

await test('O10 no budget in request -> no max_tokens forwarded', async () => {
  const r = await post('responses', { model: 'wb/hy4free', input: 'hi' });
  assert.equal(r.status, 200);
  assert.equal('max_tokens' in calls[0], false);
});

// ---- /healthz 身份字段(restart 靠它确认旧进程被换掉) ----
await test('O11 /healthz reports pid + startedAt + codeMtime', async () => {
  const socket = new Duplex({ read() {}, write(_data, _encoding, done) { done(); } });
  const req = new IncomingMessage(socket);
  req.method = 'GET';
  req.url = '/healthz';
  req.headers = { host: '127.0.0.1:39268' };
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
    const body = JSON.parse(Buffer.concat(output).toString('utf8'));
    assert.equal(body.ok, true);
    assert.equal(typeof body.pid, 'number');
    assert.match(body.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof body.codeMtime, 'string');
  } finally { socket.destroy(); }
});

console.log(failed === 0 ? `\nbridge output limits: ${passed} passed, 0 failed` : `\nbridge output limits: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
