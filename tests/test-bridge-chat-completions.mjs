// R-new: chat/completions 透传路由(聚合模式下 Hermes 走桥的 OpenAI chat 协议)。
// 复用桥的边界注入模式:真实桥源码 + 合成 IO(合成 fetch/createServer/fs)。
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
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
let lastUrl = null;
let lastAuth = null;
const context = createContext({
  path, fileURLToPath, Buffer, TextDecoder, URL, AbortController, console, Readable,
  createHash, timingSafeEqual,
  hostIsLoopback, originIsLoopback,
  process: { env: {}, on() {} },
  os: { homedir: () => '/synthetic-home' },
  fs: { readFileSync: () => JSON.stringify({ port: 1, token: 'synthetic-token' }) },
  mkdir: async () => {}, appendFile: async () => {},
  createServer(callback) {
    handler = callback;
    return { once() {}, listen(_port, host, ready) { assert.equal(host, '127.0.0.1'); ready(); } };
  },
  fetch: async (url, options) => {
    lastUrl = url;
    lastAuth = options.headers.authorization;
    calls.push(JSON.parse(options.body));
    return lastUpstream;
  },
});
let lastUpstream;
new Script(`${runnable}\nglobalThis.startBridge = serve;`, { filename: fileURLToPath(bridgeUrl) }).runInContext(context);
await context.startBridge(39268);

function chatResponse(obj, { stream = false } = {}) {
  if (stream) return new Response('data: ' + JSON.stringify(obj) + '\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function request(body, respond) {
  calls = [];
  lastUpstream = respond;
  const socket = new Duplex({ read() {}, write(_d, _e, done) { done(); } });
  const req = new IncomingMessage(socket);
  req.method = 'POST';
  req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.complete = true;
  req.url = '/v1/chat/completions';
  req.headers = { host: '127.0.0.1:39268', 'content-type': 'application/json', authorization: 'Bearer synthetic-token' };
  req.push(JSON.stringify(body));
  req.push(null);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  const output = [];
  const write = res.write.bind(res); const end = res.end.bind(res);
  res.write = (d, ...r) => { output.push(Buffer.from(d)); return write(d, ...r); };
  res.end = (d, ...r) => { if (d) output.push(Buffer.from(d)); return end(d, ...r); };
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  try {
    await handler(req, res);
    await finished;
    return { status: res.statusCode, text: Buffer.concat(output).toString('utf8') };
  } finally { socket.destroy(); }
}

let passed = 0, failed = 0;
async function test(label, run) {
  try { await run(); console.log(`ok ${++passed}. ${label}`); }
  catch (e) { failed++; console.error(`FAIL ${label}: ${e.message}`); }
}

await test('R-new1 前缀路由: trae/Doubao → 上游 model=Doubao, url 正确', async () => {
  const r = await request({ model: 'trae/Doubao-Seed-2.1-Turbo', messages: [{ role: 'user', content: 'hi' }] },
    chatResponse({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }));
  assert.equal(r.status, 200);
  assert.equal(lastUrl, 'http://127.0.0.1:1/v1/chat/completions');
  assert.equal(lastAuth, 'Bearer synthetic-token');
  assert.equal(calls[0].model, 'Doubao-Seed-2.1-Turbo');
  assert.equal(JSON.parse(r.text).choices[0].message.content, 'hi');
});

await test('R-new2 缺少前缀 → 400', async () => {
  const r = await request({ model: 'Doubao-Seed-2.1-Turbo', messages: [{ role: 'user', content: 'hi' }] },
    chatResponse({ choices: [{ message: { content: 'x' } }] }));
  assert.equal(r.status, 400);
  assert.match(r.text, /需带提供方前缀/);
});

await test('R-new3 未知前缀 → 502', async () => {
  const r = await request({ model: 'foo/bar', messages: [{ role: 'user', content: 'hi' }] },
    chatResponse({ choices: [{ message: { content: 'x' } }] }));
  assert.equal(r.status, 502);
  assert.match(r.text, /未知提供方前缀|端点未就绪/);
});

await test('R-new4 tool_choice:required 透传到上游', async () => {
  const r = await request({ model: 'trae/Doubao-Seed-2.1-Turbo', messages: [{ role: 'user', content: '查天气' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }], tool_choice: 'required' },
    chatResponse({ choices: [{ message: { role: 'assistant', tool_calls: [{ function: { name: 'get_weather' } }] } }] }));
  assert.equal(r.status, 200);
  assert.equal(calls[0].tool_choice, 'required');
  assert.equal(JSON.parse(r.text).choices[0].message.tool_calls[0].function.name, 'get_weather');
});

await test('R-new5 流式 SSE 透传(逐字转发)', async () => {
  const r = await request({ model: 'wb/auto', messages: [{ role: 'user', content: 'hi' }], stream: true },
    chatResponse({ choices: [{ delta: { content: '在' } }] }, { stream: true }));
  assert.equal(r.status, 200);
  assert.match(r.text, /data: \{.*"delta".*"content":"在"/);
  assert.match(r.text, /data: \[DONE\]/);
});

console.log(`\nchat/completions bridge: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
