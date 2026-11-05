// 端点在「上游流没发 finish frame 就断开」时会伪造 finish_reason:"length"。
// 那不是输出预算耗尽:实测 Codex 报 max_output_tokens 时单轮只输出 61/68/3958
// token,请求上限却是 128000。桥必须把它报成可重试的流故障,而不是终态 incomplete。
// 真·输出超限(usage 贴近上限)仍应保留 incomplete / max_output_tokens。
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

const LIMITS = { 'wb/deepseek-v4.1-flash': 128000 };
let upstream;
let sentPayload;
const context = createContext({
  hostIsLoopback, originIsLoopback, detectStall, CONTINUE_PROMPT,
  path, fileURLToPath, Buffer, TextDecoder, Date, Set, Map, URL, AbortController, AbortSignal, console,
  process: { env: {} },
  os: { homedir: () => '/synthetic-home' },
  fs: {
    readFileSync: (p) => String(p).includes('model-output-limits.json')
      ? JSON.stringify({ limits: LIMITS })
      : JSON.stringify({ port: 1, token: 'synthetic-token' }),
    statSync: () => ({ mtime: new Date('2026-11-05T00:00:00.000Z') }),
  },
  mkdir: async () => {}, appendFile: async () => {},
  fetch: async (_url, options) => { sentPayload = JSON.parse(options.body); return upstream; },
});
new Script(`${runnable}\nglobalThis.bridgeHandle = handle;\nglobalThis.testExports = { isSpuriousLength };`,
  { filename: fileURLToPath(bridgeUrl) }).runInContext(context);
const { isSpuriousLength } = context.testExports;

function chunk(delta, finish_reason = null, usage) {
  return { choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) };
}
const textChunk = chunk({ content: 'partial answer' });
const smallUsage = { prompt_tokens: 27350, completion_tokens: 61, total_tokens: 27411 };
const nearCapUsage = { prompt_tokens: 27350, completion_tokens: 127900, total_tokens: 155250 };

function response(chunks) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok: true, status: 200,
    body: new ReadableStream({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[index++])}\n\n`));
        else controller.close();
      },
    }),
  };
}

async function request(route, body, chunks, stream = false) {
  upstream = response(chunks);
  sentPayload = null;
  const bytes = [];
  const socket = new Duplex({
    read() {},
    write(data, _encoding, callback) { bytes.push(Buffer.from(data)); callback(); },
  });
  const req = new IncomingMessage(socket);
  req.method = 'POST';
  req.headers = { host: '127.0.0.1:39268', 'content-type': 'application/json' };
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.complete = true;
  req.url = `/v1/${route}`;
  req.push(JSON.stringify({
    model: 'wb/deepseek-v4.1-flash', stream,
    input: 'hi', messages: [{ role: 'user', content: 'hi' }],
    ...body,
  }));
  req.push(null);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  try {
    await context.bridgeHandle(req, res);
    await finished;
    const wire = Buffer.concat(bytes).toString('utf8');
    const split = wire.indexOf('\r\n\r\n');
    const headers = wire.slice(0, split);
    let raw = wire.slice(split + 4);
    if (/transfer-encoding: chunked/i.test(headers)) {
      let decoded = '';
      while (raw) {
        const nl = raw.indexOf('\r\n');
        const size = parseInt(raw.slice(0, nl), 16);
        if (!size) break;
        const buf = Buffer.from(raw.slice(nl + 2));
        decoded += buf.subarray(0, size).toString('utf8');
        raw = buf.subarray(size + 2).toString('utf8');
      }
      raw = decoded;
    }
    return { status: res.statusCode, body: raw };
  } finally { socket.destroy(); }
}

let passed = 0;
let failed = 0;
async function test(label, run) {
  try { await run(); console.log(`ok ${++passed}. ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.message}`); }
}

// ---- 纯函数边界 ----
await test('S1 length with tiny output is spurious', () => {
  assert.equal(isSpuriousLength({ finish: 'length', usage: { output_tokens: 61 } }, { max_tokens: 128000 }), true);
});
await test('S2 length without usage is spurious', () => {
  assert.equal(isSpuriousLength({ finish: 'length', usage: null }, { max_tokens: 128000 }), true);
});
await test('S3 length near cap is a real output cap', () => {
  assert.equal(isSpuriousLength({ finish: 'length', usage: { output_tokens: 127900 } }, { max_tokens: 128000 }), false);
});
await test('S4 stop is never spurious', () => {
  assert.equal(isSpuriousLength({ finish: 'stop', usage: { output_tokens: 1 } }, { max_tokens: 128000 }), false);
});
await test('S5 no forwarded budget keeps legacy behaviour', () => {
  assert.equal(isSpuriousLength({ finish: 'length', usage: { output_tokens: 1 } }, {}), false);
});

// ---- Responses 端到端 ----
await test('S6 spurious length becomes failed, not incomplete/max_output_tokens', async () => {
  const result = await request('responses', { max_output_tokens: 128000 },
    [textChunk, chunk({}, 'length', smallUsage)]);
  const body = JSON.parse(result.body);
  // 非流式在流故障时走 502(桥原有约定),载荷本身仍是 failed response。
  assert.equal(result.status, 502);
  assert.equal(body.status, 'failed');
  assert.equal(body.incomplete_details, null);
  assert.ok(body.error, 'failed response must carry an error the client can retry on');
  assert.equal(sentPayload.max_tokens, 128000);
});
await test('S7 real output cap still reports incomplete/max_output_tokens', async () => {
  const result = await request('responses', { max_output_tokens: 128000 },
    [textChunk, chunk({}, 'length', nearCapUsage)]);
  const body = JSON.parse(result.body);
  assert.equal(body.status, 'incomplete');
  assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' });
});
await test('S8 request without max_tokens keeps legacy incomplete', async () => {
  const result = await request('responses', {}, [textChunk, chunk({}, 'length')]);
  const body = JSON.parse(result.body);
  assert.equal(body.status, 'incomplete');
  assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' });
});
await test('S9 streamed spurious length emits response.failed', async () => {
  const result = await request('responses', { max_output_tokens: 128000 },
    [textChunk, chunk({}, 'length', smallUsage)], true);
  const events = result.body.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map(l => JSON.parse(l.slice(6)));
  const terminal = events.filter(e => ['response.completed', 'response.incomplete', 'response.failed'].includes(e.type));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, 'response.failed');
  assert.equal(terminal[0].response.incomplete_details, null);
});

// ---- Messages 端到端 ----
await test('S10 messages route reports a retryable error, not max_tokens', async () => {
  const result = await request('messages', { max_tokens: 128000 },
    [textChunk, chunk({}, 'length', smallUsage)]);
  const body = JSON.parse(result.body);
  assert.equal(result.status, 502);
  assert.equal(body.type, 'error');
  assert.doesNotMatch(JSON.stringify(body), /max_tokens/);
});

console.log(failed === 0
  ? `\nbridge spurious length: ${passed} passed, 0 failed`
  : `\nbridge spurious length: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
