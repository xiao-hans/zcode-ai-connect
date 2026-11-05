// R04/R10: exercise the captured createServer entry with real HTTP objects.
// Only credentials, fetch, logs and server startup are replaced; no socket listens.
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
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
const env = {};
let handler;
let credentialReads = 0;
let bodyReads = 0;
let calls = [];
const context = createContext({
  path, fileURLToPath, Buffer, TextDecoder, URL, AbortController, AbortSignal, console,
  createHash, timingSafeEqual,
  hostIsLoopback, originIsLoopback, detectStall, CONTINUE_PROMPT,
  process: { env, on() {} },
  os: { homedir: () => '/synthetic-home' },
  fs: { readFileSync() { credentialReads++; return JSON.stringify({ port: 1, token: 'synthetic-token' }); } },
  mkdir: async () => {}, appendFile: async () => {},
  createServer(callback) {
    handler = callback;
    return { once() {}, listen(_port, host, ready) { assert.equal(host, '127.0.0.1'); ready(); } };
  },
  fetch: async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    assert.equal(url, 'http://127.0.0.1:1/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    const chunk = { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  },
});
new Script(`${runnable}\nglobalThis.startBridge = serve;`, { filename: fileURLToPath(bridgeUrl) }).runInContext(context);
await context.startBridge(39268);
assert.equal(typeof handler, 'function');

const prompt = { role: 'user', content: 'Inspect the file.' };
const feedback = { role: 'user', content: 'Stop hook feedback:\nContinue by calling a tool.' };
const toolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }] };
const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] };
const tool = { name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };

async function request(route, { headers = {}, body = {}, method = 'POST', rawBody } = {}) {
  // Avoid the endpoint cache hiding forbidden credential reads between cases.
  new Script('epCache.clear()').runInContext(context);
  credentialReads = 0;
  bodyReads = 0;
  calls = [];
  const socket = new Duplex({ read() {}, write(_data, _encoding, done) { done(); } });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.complete = true;
  req.url = route;
  req.headers = { host: '127.0.0.1:39268', 'content-type': 'application/json', authorization: 'Bearer synthetic-token', ...headers };
  const iterate = req[Symbol.asyncIterator].bind(req);
  req[Symbol.asyncIterator] = function () { bodyReads++; return iterate(); };
  req.push(rawBody ?? JSON.stringify({ model: 'trae/test', stream: false, input: 'hi', messages: [prompt], tools: [tool], ...body }));
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
    assert.match(res.getHeader('content-type') ?? res._header, /application\/json/);
    return { status: res.statusCode, body: JSON.parse(Buffer.concat(output).toString('utf8')) };
  } finally { socket.destroy(); }
}

let passed = 0;
let failed = 0;
async function test(label, run) {
  try { await run(); console.log(`ok ${++passed}. ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.message}`); }
}

for (const route of ['/v1/messages', '/messages', '/v1/responses', '/responses']) {
  await test(`R04 legal CLI ${route}`, async () => {
    const result = await request(route);
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(credentialReads, 1);
    assert.equal(bodyReads, 1);
    assert.equal(calls[0].payload.model, 'test');
    assert.equal(result.body[route.includes('responses') ? 'object' : 'type'], route.includes('responses') ? 'response' : 'message');
  });
  for (const [label, headers, status] of [
    ['external Host', { host: 'evil.example:39268' }, 403],
    ['missing Host', { host: undefined }, 403],
    ['external Origin', { origin: 'https://evil.example' }, 403],
    ['opaque Origin', { origin: 'null' }, 403],
    ['plain text', { 'content-type': 'text/plain' }, 415],
    ['form', { 'content-type': 'application/x-www-form-urlencoded' }, 415],
    ['missing Content-Type', { 'content-type': undefined }, 415],
  ]) {
    await test(`R04 ${route} rejects ${label} before IO`, async () => {
      const result = await request(route, { headers });
      assert.equal(result.status, status);
      assert.ok(result.body.error);
      assert.equal(credentialReads, 0, 'must reject before endpoint credential discovery');
      assert.equal(calls.length, 0, 'must not call upstream');
      assert.equal(bodyReads, 0, 'must reject before body parsing');
    });
  }
}
for (const [host, origin] of [
  ['localhost:39268', 'http://localhost:5000'],
  ['[::1]:39268', 'http://[::1]:5000'],
  ['127.0.0.1:39268', undefined],
]) {
  await test(`R04 loopback ${host} with JSON parameters`, async () => {
    assert.equal((await request('/v1/messages', { headers: { host, origin, 'content-type': 'Application/JSON; charset=utf-8' } })).status, 200);
    assert.equal(calls.length, 1);
  });
}
for (const route of ['/healthz', '/v1/models']) {
  await test(`R04 GET ${route} rejects external Host before credentials`, async () => {
    assert.equal((await request(route, { method: 'GET', headers: { host: 'evil.example' } })).status, 403);
    assert.equal(credentialReads, 0);
    assert.equal(calls.length, 0);
  });
}
await test('R04 count_tokens also requires JSON', async () => {
  assert.equal((await request('/v1/messages/count_tokens', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(bodyReads, 0);
  assert.equal(credentialReads, 0);
});
await test('bridge auth rejects a missing bearer before endpoint credentials', async () => {
  const result = await request('/v1/messages', { headers: { authorization: undefined } });
  assert.equal(result.status, 401);
  assert.equal(credentialReads, 0);
  assert.equal(calls.length, 0);
  assert.equal(bodyReads, 0);
  assert.equal(JSON.stringify(result.body).includes('synthetic-token'), false);
});
await test('bridge auth rejects a wrong bearer before endpoint credentials', async () => {
  const result = await request('/v1/responses', { headers: { authorization: 'Bearer not-the-bridge-token' } });
  assert.equal(result.status, 401);
  assert.equal(credentialReads, 0);
  assert.equal(calls.length, 0);
  assert.equal(bodyReads, 0);
});
await test('bridge auth accepts x-api-key', async () => {
  const result = await request('/v1/messages', { headers: { authorization: undefined, 'x-api-key': 'synthetic-token' } });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, 'Bearer synthetic-token');
});
await test('R04 rejected source precedes malformed JSON parsing', async () => {
  assert.equal((await request('/v1/messages', { headers: { origin: 'https://evil.example' }, rawBody: '{' })).status, 403);
  assert.equal(bodyReads, 0);
  assert.equal(credentialReads, 0);
  assert.equal(calls.length, 0);
});

for (const role of ['user', 'system']) {
  for (const content of [feedback.content, [{ type: 'text', text: feedback.content }]]) {
    await test(`R10 pending ${role} feedback ${typeof content} forces required`, async () => {
      assert.equal((await request('/v1/messages', { body: { messages: [prompt, { role, content }] } })).status, 200);
      assert.equal(calls[0].payload.tool_choice, 'required');
    });
  }
}
for (const [label, messages, choice, expected] of [
  ['tool result restores default', [prompt, feedback, toolUse, toolResult], undefined, undefined],
  ['tool result restores auto', [prompt, feedback, toolUse, toolResult], { type: 'auto' }, 'auto'],
  ['tool result restores named selection', [prompt, feedback, toolUse, toolResult], { type: 'tool', name: 'read' }, { type: 'function', function: { name: 'read' } }],
  ['tool result restores none', [prompt, feedback, toolUse, toolResult], { type: 'none' }, 'none'],
  ['new string user turn ends old feedback', [prompt, feedback, { role: 'user', content: 'A new task.' }], { type: 'auto' }, 'auto'],
  ['new text-block user turn ends old feedback', [prompt, feedback, { role: 'user', content: [{ type: 'text', text: 'A new task.' }] }], { type: 'auto' }, 'auto'],
  ['pending feedback survives three non-work messages', [prompt, feedback, { role: 'assistant', content: 'I will inspect it.' }, { role: 'system', content: 'Context reminder.' }, { role: 'assistant', content: 'Continuing.' }], undefined, 'required'],
  ['new feedback after completed work forces again', [prompt, feedback, toolUse, toolResult, { role: 'assistant', content: 'Continuing.' }, feedback], undefined, 'required'],
  ['tool invocation itself ends pending feedback', [prompt, feedback, toolUse], { type: 'auto' }, 'auto'],
  ['tool result plus user text ends pending feedback', [prompt, feedback, toolUse, { role: 'user', content: [...toolResult.content, { type: 'text', text: 'Now summarize.' }] }], { type: 'auto' }, 'auto'],
  ['no feedback preserves caller choice', [prompt], { type: 'any' }, 'required'],
]) {
  await test(`R10 ${label}`, async () => {
    assert.equal((await request('/v1/messages', { body: { messages, tool_choice: choice } })).status, 200);
    assert.deepEqual(calls[0].payload.tool_choice, expected);
  });
}
await test('R10 non-Trae provider remains caller-controlled', async () => {
  assert.equal((await request('/v1/messages', { body: { model: 'wb/test', messages: [prompt, feedback], tool_choice: { type: 'auto' } } })).status, 200);
  assert.equal(calls[0].payload.tool_choice, 'auto');
});
await test('R10 no declared tools does not force selection', async () => {
  assert.equal((await request('/v1/messages', { body: { messages: [prompt, feedback], tools: [] } })).status, 200);
  assert.equal(calls[0].payload.tool_choice, undefined);
});
await test('R10 environment opt-out remains effective', async () => {
  env.ZC_FORCE_TOOL_CONTINUE = '0';
  try {
    assert.equal((await request('/v1/messages', { body: { messages: [prompt, feedback], tool_choice: { type: 'auto' } } })).status, 200);
    assert.equal(calls[0].payload.tool_choice, 'auto');
  } finally { delete env.ZC_FORCE_TOOL_CONTINUE; }
});
console.log(`bridge R04/R10: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

// Keep the legacy command flag as an alias; its fixture now runs directly.
if (process.argv.includes('--legacy-errors')) {
  await import('./test-bridge-responses-errors.mjs');
}
