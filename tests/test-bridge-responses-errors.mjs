// R02/R03: run the real bridge handlers with synthetic endpoint/network IO only.
// No bridge CLI, credential files, service process or listening socket is used.
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
// Keep handler/builder/parser bodies unchanged; replace only imports and CLI IO.
const runnable = source.slice(0, source.indexOf('const argv = process.argv.slice(2);'))
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(bridgeUrl.href));
let upstream;
const context = createContext({
  hostIsLoopback, originIsLoopback, path, fileURLToPath, Buffer, TextDecoder, Date, Set, Map, URL, AbortController, console,
  process: { env: {} },
  os: { homedir: () => '/synthetic-home' },
  fs: { readFileSync: () => JSON.stringify({ port: 1, token: 'synthetic-token' }) },
  mkdir: async () => {}, appendFile: async () => {},
  fetch: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:1/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    return upstream;
  },
});
new Script(`${runnable}\nglobalThis.bridgeHandle = handle;`, { filename: fileURLToPath(bridgeUrl) }).runInContext(context);

function chunk(delta, finish_reason = null, usage) {
  return { choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) };
}
const textChunk = chunk({ content: 'partial answer' });
const toolChunk = chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] });
const upstreamError = { message: 'synthetic upstream failure', type: 'upstream_broken', code: 'test_error' };

function response(chunks, broken = false) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok: true, status: 200,
    body: new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[index++])}\n\n`));
        } else if (broken) {
          controller.error(new Error('synthetic reader failure'));
        } else controller.close();
      },
    }),
  };
}

// Real ServerResponse commits headers on its first write, catching R02's
// ERR_HTTP_HEADERS_SENT without opening a listening test server.
async function request(route, stream, chunks, broken = false) {
  upstream = response(chunks, broken);
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
  req.push(JSON.stringify({ model: 'trae/test', stream, input: 'hi', messages: [{ role: 'user', content: 'hi' }] }));
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
    let body = wire.slice(split + 4);
    if (/transfer-encoding: chunked/i.test(headers)) {
      let decoded = '';
      while (body) {
        const nl = body.indexOf('\r\n');
        const size = parseInt(body.slice(0, nl), 16);
        if (!size) break;
        const raw = Buffer.from(body.slice(nl + 2));
        decoded += raw.subarray(0, size).toString('utf8');
        body = raw.subarray(size + 2).toString('utf8');
      }
      body = decoded;
    }
    return { status: res.statusCode, contentType: /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim(), headers, body };
  } finally { socket.destroy(); }
}

function json(result) {
  assert.match(result.contentType, /^application\/json/);
  assert.doesNotMatch(result.body, /(?:^|\n)(?:event:|data:)/);
  return JSON.parse(result.body);
}
function events(result) {
  assert.match(result.contentType, /^text\/event-stream/);
  return result.body.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)));
}

let passed = 0;
for (const route of ['responses', 'messages']) {
  for (const [label, chunks, finish] of [
    ['text', [textChunk, chunk({}, 'stop', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })], 'stop'],
    ['tool', [toolChunk, chunk({}, 'tool_calls')], 'tool_calls'],
    ['length', [textChunk, chunk({}, 'length')], 'length'],
  ]) {
    const result = await request(route, false, chunks);
    const body = json(result);
    assert.equal(result.status, 200);
    if (route === 'responses') {
      assert.equal(body.object, 'response');
      assert.equal(body.status, finish === 'length' ? 'incomplete' : 'completed');
      assert.equal(body.error, null);
      assert.deepEqual(body.incomplete_details, finish === 'length' ? { reason: 'max_output_tokens' } : null);
      if (label === 'tool') {
        assert.equal(body.output[0].name, 'read');
        assert.equal(body.output[0].arguments, '{"path":"a"}');
      } else assert.equal(body.output[0].content[0].text, 'partial answer');
      if (label === 'text') assert.equal(body.usage.total_tokens, 5);
    } else {
      assert.equal(body.type, 'message');
      assert.equal(body.stop_reason, { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' }[finish]);
      if (label === 'tool') assert.deepEqual(body.content[0].input, { path: 'a' });
      else assert.equal(body.content[0].text, 'partial answer');
    }
    console.log(`ok ${++passed}. ${route} JSON ${label}`);
    const streamed = await request(route, true, chunks);
    assert.equal(streamed.status, 200);
    const parsed = events(streamed);
    if (route === 'responses') {
      const terminal = parsed.filter(e => ['response.completed', 'response.incomplete', 'response.failed'].includes(e.type));
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].response.status, finish === 'length' ? 'incomplete' : 'completed');
      assert.equal(terminal[0].response.error, null);
      if (label === 'tool') assert.equal(terminal[0].response.output[0].name, 'read');
    } else {
      assert.equal(parsed.filter(e => e.type === 'message_stop').length, 1);
      assert.equal(parsed.find(e => e.type === 'message_delta').delta.stop_reason, { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' }[finish]);
    }
    console.log(`ok ${++passed}. ${route} SSE ${label}`);
  }
  for (const [label, chunks, broken, errorText] of [
    ['first-frame error', [{ error: upstreamError }], false, 'synthetic upstream failure'],
    ['error after text', [textChunk, { error: upstreamError }], false, 'synthetic upstream failure'],
    ['reader throws', [], true, 'synthetic reader failure'],
    ['reader throws after text', [textChunk], true, 'synthetic reader failure'],
  ]) {
    for (const stream of [false, true]) {
      const result = await request(route, stream, chunks, broken);
      if (!stream) {
        const body = json(result);
        assert.equal(result.status, 502);
        assert.ok(body.error);
        assert.ok(body.error.message.includes(errorText));
        if (route === 'responses') {
          assert.equal(body.status, 'failed');
          assert.equal(body.error.type, 'upstream_broken');
          if (!broken) assert.equal(body.error.code, 'test_error');
          if (chunks[0] === textChunk) assert.equal(body.output[0].content[0].text, 'partial answer');
        } else {
          assert.equal(body.type, 'error');
          assert.equal(body.error.type, 'api_error');
          assert.equal(body.stop_reason, undefined);
        }
      } else {
        assert.equal(result.status, 200);
        const parsed = events(result);
        assert.equal(parsed.some(e => e.type === 'response.completed' || e.type === 'response.incomplete' || e.type === 'message_stop'), false);
        const failure = parsed.find(e => e.type === (route === 'responses' ? 'response.failed' : 'error'));
        assert.ok(failure, result.body);
        const error = route === 'responses' ? failure.response.error : failure.error;
        assert.ok(error.message.includes(errorText));
        if (route === 'responses') assert.equal(failure.response.status, 'failed');
      }
      console.log(`ok ${++passed}. ${route} ${stream ? 'SSE' : 'JSON'} ${label}`);
    }
  }
}
console.log(`all ${passed} bridge R02/R03 regression cases passed`);
