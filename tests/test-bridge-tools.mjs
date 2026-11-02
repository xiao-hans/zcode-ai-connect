// R05/R08/R09: real bridge source and HTTP objects, synthetic IO only.
// Boundary-test injection pattern: no listening socket or real credentials.
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
let upstream;
let calls = [];
const context = createContext({
  path, fileURLToPath, Buffer, TextDecoder, URL, AbortController, console,
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
    assert.equal(url, 'http://127.0.0.1:1/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    calls.push(JSON.parse(options.body));
    return upstream(calls.length);
  },
});
new Script(`${runnable}\nglobalThis.startBridge = serve;`, { filename: fileURLToPath(bridgeUrl) }).runInContext(context);
await context.startBridge(39268);

const schema = { type: 'object', properties: { path: { type: 'string' } } };
const tools = ['read', 'write', 'list'].map(name => ({ name, input_schema: schema }));
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const tool = (index, args, name, id) => ({ index, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args } });
const sse = chunks => new Response(chunks.map(d => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n');
const events = text => text.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));

async function request(route, stream, chunks = [], extra = {}, respond = () => sse(chunks)) {
  calls = [];
  upstream = respond;
  const socket = new Duplex({ read() {}, write(_data, _encoding, done) { done(); } });
  const req = new IncomingMessage(socket);
  req.method = 'POST';
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.complete = true;
  req.url = `/v1/${route}`;
  req.headers = { host: '127.0.0.1:39268', 'content-type': 'application/json' };
  req.push(JSON.stringify({
    model: 'trae/test', stream, input: 'hi', messages: [{ role: 'user', content: 'hi' }],
    tools: route === 'messages' ? tools : tools.map(t => ({ type: 'function', name: t.name, parameters: schema })),
    ...extra,
  }));
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
    const text = Buffer.concat(output).toString('utf8');
    const contentType = res.getHeader('content-type') ?? res._header;
    return { status: res.statusCode, text, contentType };
  } finally { socket.destroy(); }
}

// Reconstruct only the client wire; never reproduce the bridge's aggregation.
function message(result, stream) {
  assert.equal(result.status, 200, result.text);
  if (!stream) {
    assert.match(result.contentType, /application\/json/);
    return JSON.parse(result.text);
  }
  assert.match(result.contentType, /text\/event-stream/);
  const es = events(result.text);
  const blocks = [];
  let active = null;
  let args = '';
  for (const e of es) {
    if (e.type === 'content_block_start') {
      assert.equal(active, null, 'blocks must not overlap');
      assert.equal(e.index, blocks.length, 'block indices must be sequential');
      active = e;
      args = '';
    } else if (e.type === 'content_block_delta') {
      assert.equal(e.index, active?.index, 'delta must target an open block');
      if (e.delta.type === 'input_json_delta') args += e.delta.partial_json;
      else if (e.delta.type === 'text_delta') active.content_block.text += e.delta.text;
    } else if (e.type === 'content_block_stop') {
      assert.equal(e.index, active?.index, 'stop must target an open block');
      if (active.content_block.type === 'tool_use') active.content_block.input = JSON.parse(args || '{}');
      blocks.push(active.content_block);
      active = null;
    }
  }
  assert.equal(active, null);
  assert.equal(es.filter(e => e.type === 'message_stop').length, 1, result.text);
  return { content: blocks, stop_reason: es.find(e => e.type === 'message_delta')?.delta.stop_reason };
}

let passed = 0;
let failed = 0;
async function test(label, run) {
  try { await run(); console.log(`ok ${++passed}. ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.message}`); }
}

const interleaved = [
  chunk({ content: 'Working.' }),
  chunk({ tool_calls: [tool(0, '{"path":', 'read', 'r'), tool(1, '{"path":', 'write', 'w'), tool(2, '{"path":', 'list', 'l')] }),
  chunk({ tool_calls: [tool(1, '"b"}'), tool(0, '"a"}'), tool(2, '"c"}')] }),
  chunk({}, 'tool_calls'),
];
const delayed = [
  chunk({ tool_calls: [tool(0, '{"path":', undefined, 'r'), tool(1, '{"path":"b"}', 'write', 'w')] }),
  chunk({ tool_calls: [tool(0, '"a"}'), tool(2, '{"path":"c"}', undefined, 'l')] }),
  chunk({ tool_calls: [tool(2, '', 'list'), tool(0, '', 'read')] }),
  chunk({}, 'tool_calls'),
];
for (const stream of [false, true]) {
  for (const [label, chunks] of [['interleaved three tools', interleaved], ['arguments before delayed names', delayed]]) {
    await test(`R05 ${stream ? 'SSE' : 'JSON'} ${label}`, async () => {
      const body = message(await request('messages', stream, chunks), stream);
      assert.equal(body.stop_reason, 'tool_use');
      const actual = body.content.filter(b => b.type === 'tool_use');
      assert.equal(actual.length, 3);
      for (const [id, name, value] of [['r', 'read', 'a'], ['w', 'write', 'b'], ['l', 'list', 'c']]) {
        assert.deepEqual(actual.find(b => b.id === id), { type: 'tool_use', id, name, input: { path: value } });
      }
    });
  }
}

const dsml = (name = 'read', param = '<｜DSML｜parameter name="path" string="true">a</｜DSML｜parameter>') =>
  `<｜DSML｜tool_calls><｜DSML｜invoke name="${name}">${param}</｜DSML｜invoke></｜DSML｜tool_calls>`;
for (const route of ['messages', 'responses']) {
  for (const stream of [false, true]) {
    for (const split of [false, true]) {
      await test(`R08 ${route} ${stream ? 'SSE' : 'JSON'} ${split ? 'cross-frame' : 'whole'} DSML`, async () => {
        const text = `before ${dsml()} between ${dsml('write')} after`;
        const parts = split ? [...text] : [text];
        const result = await request(route, stream, [...parts.map(content => chunk({ content })), chunk({}, 'tool_calls')]);
        let blocks;
        if (route === 'messages') {
          const body = message(result, stream);
          assert.equal(body.stop_reason, 'tool_use');
          blocks = body.content;
        } else {
          assert.equal(result.status, 200, result.text);
          blocks = stream ? events(result.text).find(e => e.type === 'response.completed')?.response.output : JSON.parse(result.text).output;
        }
        const actual = blocks.filter(b => b.type === (route === 'messages' ? 'tool_use' : 'function_call'));
        assert.equal(actual.length, 2, result.text);
        assert.deepEqual(actual.map(b => b.name), ['read', 'write']);
        for (const b of actual) assert.deepEqual(route === 'messages' ? b.input : JSON.parse(b.arguments), { path: 'a' });
        const plain = blocks.filter(b => b.type === (route === 'messages' ? 'text' : 'message'))
          .map(b => b.text ?? b.content.map(p => p.text).join('')).join('');
        assert.equal(plain, 'before  between  after');
      });
    }
  }
}

for (const [label, text] of [
  ['ordinary text', 'Plain <tag> x ｜ y.'],
  ['undeclared tool', dsml('erase')],
  ['prefix is not a declared tool', dsml('rea')],
  ['incomplete outer block', dsml().replace('</｜DSML｜tool_calls>', '')],
  ['incomplete invoke', dsml().replace('</｜DSML｜invoke>', '')],
  ['incomplete parameter', dsml().replace('</｜DSML｜parameter>', '')],
  ['invalid JSON parameter', dsml('read', '<｜DSML｜parameter name="path" string="false">{broken</｜DSML｜parameter>')],
]) {
  for (const route of ['messages', 'responses']) {
    await test(`R08 ${route} does not execute ${label}`, async () => {
      const result = await request(route, false, [...text].map(content => chunk({ content })));
      assert.equal(result.status, 200, result.text);
      const body = JSON.parse(result.text);
      const blocks = route === 'messages' ? body.content : body.output;
      assert.equal(blocks.some(b => b.type === 'tool_use' || b.type === 'function_call'), false, result.text);
      if (label === 'ordinary text') {
        assert.equal(route === 'messages' ? blocks[0].text : blocks[0].content[0].text, text);
      }
    });
  }
}
for (const stream of [false, true]) {
  await test(`R05 ${stream ? 'SSE' : 'JSON'} invalid arguments do not become empty input`, async () => {
    const result = await request('messages', stream, [chunk({ tool_calls: [tool(0, '{broken', 'read', 'r')] }), chunk({}, 'tool_calls')]);
    if (!stream) {
      assert.equal(result.status, 502, result.text);
      assert.ok(JSON.parse(result.text).error);
    } else {
      const es = events(result.text);
      assert.ok(es.find(e => e.type === 'error'), result.text);
      assert.equal(es.some(e => e.type === 'message_stop'), false);
      assert.equal(es.some(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use'), false);
    }
  });
  await test(`R05 ${stream ? 'SSE' : 'JSON'} nameless call preserves R03 stop consistency`, async () => {
    const body = message(await request('messages', stream, [chunk({ tool_calls: [tool(0, '{}', undefined, 'r')] }), chunk({}, 'tool_calls')]), stream);
    assert.equal(body.stop_reason, 'end_turn');
    assert.equal(body.content.some(b => b.type === 'tool_use'), false);
  });
}

for (const route of ['messages', 'responses']) {
  for (const stream of [false, true]) {
    for (const [label, choice, expected] of [
      ['required', route === 'messages' ? { type: 'any' } : 'required', 'required'],
      ['none', route === 'messages' ? { type: 'none' } : 'none', 'none'],
      ['named', route === 'messages' ? { type: 'tool', name: 'read' } : { type: 'function', name: 'read' }, { type: 'function', function: { name: 'read' } }],
    ]) {
      await test(`R09 ${route} ${stream ? 'SSE' : 'JSON'} ${label} keeps upstream 400`, async () => {
        const reason = `unsupported tool_choice: ${label}`;
        const result = await request(route, stream, [], { tool_choice: choice }, n =>
          n === 1 ? new Response(JSON.stringify({ error: { message: reason } }), { status: 400 }) : sse([chunk({ content: 'must not succeed' }, 'stop')]));
        assert.equal(calls.length, 1, 'a rejected constraint must not trigger a permissive retry');
        assert.deepEqual(calls[0].tool_choice, expected);
        assert.equal(result.status, 400, result.text);
        assert.match(result.contentType, /application\/json/);
        assert.ok(JSON.parse(result.text).error);
        assert.ok(result.text.includes(reason));
      });
    }
  }
  await test(`R09 ${route} retains existing compatible field retry and choice`, async () => {
    const choice = route === 'messages' ? { type: 'any' } : 'required';
    const result = await request(route, false, [], { tool_choice: choice, max_tokens: 40 }, n =>
      n === 1 ? new Response('unsupported stream_options', { status: 400 }) : sse([chunk({ content: 'ok' }, 'stop')]));
    assert.equal(result.status, 200, result.text);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].tool_choice, 'required');
  });
}
await test('R09 forced R10 continuation cannot downgrade on 400', async () => {
  const result = await request('messages', false, [], {
    messages: [{ role: 'user', content: 'Stop hook feedback: continue.' }],
  }, n => n === 1 ? new Response('unsupported tool_choice', { status: 400 }) : sse([chunk({ content: 'downgraded' }, 'stop')]));
  assert.equal(calls[0].tool_choice, 'required');
  assert.equal(calls.length, 1);
  assert.equal(result.status, 400);
});
console.log(`bridge R05/R08/R09: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
