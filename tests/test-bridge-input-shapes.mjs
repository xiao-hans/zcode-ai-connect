// R11: Responses 的 input 形状兼容性。
//
// EasyInputMessage 允许省略 type(只带 role/content);以前只认 type === 'message',
// 这种条目被静默丢掉,messages 变空后才由上游回一句 "messages is required"。
// 这里直接观察桥发给端点的 payload,并确认空 input 在本地就被拦下。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createContext, Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hostIsLoopback, originIsLoopback } from '../zcode-trae-connect/src/loopback.js';

const bridgeUrl = new URL('../scripts/codex-responses-bridge.mjs', import.meta.url);
const source = readFileSync(bridgeUrl, 'utf8');
const runnable = source.slice(0, source.indexOf('const argv = process.argv.slice(2);'))
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(bridgeUrl.href));

let handler;
let calls = [];
const context = createContext({
  path, fileURLToPath, Buffer, TextDecoder, URL, AbortController, AbortSignal, console,
  hostIsLoopback, originIsLoopback,
  process: { env: {}, on() {} },
  os: { homedir: () => '/synthetic-home' },
  fs: { readFileSync: () => JSON.stringify({ port: 1, token: 'synthetic-token' }) },
  mkdir: async () => {}, appendFile: async () => {},
  createServer(callback) {
    handler = callback;
    return { once() {}, listen(_port, _host, ready) { ready(); } };
  },
  fetch: async (url, options) => {
    calls.push(JSON.parse(options.body));
    const chunk = { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  },
});
new Script(`${runnable}\nglobalThis.startBridge = serve;`, { filename: fileURLToPath(bridgeUrl) }).runInContext(context);
await context.startBridge(39268);
assert.equal(typeof handler, 'function');

async function post(body) {
  new Script('epCache.clear()').runInContext(context);
  calls = [];
  const socket = new Duplex({ read() {}, write(_data, _encoding, done) { done(); } });
  const req = new IncomingMessage(socket);
  req.method = 'POST';
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.complete = true;
  req.url = '/v1/responses';
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
    return { status: res.statusCode, body: JSON.parse(Buffer.concat(output).toString('utf8')) };
  } finally { socket.destroy(); }
}

let passed = 0;
let failed = 0;
async function test(label, run) {
  try { await run(); console.log(`ok ${++passed}. ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.message}`); }
}

const wireMessages = () => calls[0].messages;

await test('R11 EasyInputMessage without type maps to a chat message', async () => {
  const result = await post({ input: [{ role: 'user', content: '你好' }] });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(wireMessages(), [{ role: 'user', content: '你好' }]);
  assert.equal('input' in calls[0], false, 'chat upstream must receive messages, not input');
});

await test('R11 text parts still work when type is present', async () => {
  const result = await post({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] });
  assert.equal(result.status, 200);
  assert.deepEqual(wireMessages(), [{ role: 'user', content: 'hi' }]);
});

await test('R11 string input still maps to one user message', async () => {
  const result = await post({ input: 'hi' });
  assert.equal(result.status, 200);
  assert.deepEqual(wireMessages(), [{ role: 'user', content: 'hi' }]);
});

await test('R11 instructions + untyped input keeps the system message first', async () => {
  const result = await post({ instructions: 'be brief', input: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.status, 200);
  assert.deepEqual(wireMessages(), [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]);
});

await test('R11 developer role becomes system', async () => {
  const result = await post({ input: [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hi' }] });
  assert.equal(result.status, 200);
  assert.deepEqual(wireMessages(), [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }]);
});

await test('R11 multi-turn untyped history keeps order', async () => {
  const result = await post({ input: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }] });
  assert.equal(result.status, 200);
  assert.deepEqual(wireMessages().map(m => m.role), ['user', 'assistant', 'user']);
});

for (const [label, input] of [
  ['empty array', []],
  ['only non-message items', [{ type: 'reasoning', summary: [] }]],
  ['only blank content', [{ role: 'user', content: '' }]],
]) {
  await test(`R11 ${label} is rejected locally with a clear message`, async () => {
    const result = await post({ input });
    assert.equal(result.status, 400, 'must not forward an empty messages array upstream');
    assert.equal(calls.length, 0, 'must reject before touching the endpoint');
    assert.match(result.body.error.message, /没有可转换的消息/);
  });
}

console.log(failed === 0 ? `\nbridge input shapes: ${passed} passed, 0 failed` : `\nbridge input shapes: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
