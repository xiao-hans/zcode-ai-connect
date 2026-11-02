// R13: load real handlers; replace only endpoint, fetch, logs and socket IO.
// No listening port, bridge CLI or real account/credential access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
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
let respond;
const calls = [];
const context = createContext({
  path, fileURLToPath, Buffer, TextDecoder, URL, AbortController, AbortSignal, console,
  hostIsLoopback, originIsLoopback,
  process: { env: {} },
  os: { homedir: () => '/synthetic-home' },
  fs: { readFileSync: () => JSON.stringify({ port: 1, token: 'synthetic-token' }) },
  mkdir: async () => {}, appendFile: async () => {},
  fetch: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:1/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    calls.push(options);
    return respond(options, calls.length);
  },
});
new Script(`${runnable}\nglobalThis.bridgeHandle = handle;`, { filename: fileURLToPath(bridgeUrl) }).runInContext(context);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, bad) => { resolve = ok; reject = bad; });
  return { promise, resolve, reject };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 500);
    })]);
  } finally { clearTimeout(timer); }
}
const text = { choices: [{ index: 0, delta: { content: 'partial answer' }, finish_reason: null }] };
const stop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
const encoder = new TextEncoder();
const frame = value => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);

function streamResponse() {
  let controller;
  let reads = 0;
  let cancels = 0;
  let releases = 0;
  const waiters = [];
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancels++; },
  }, { highWaterMark: 0 });
  const getReader = body.getReader.bind(body);
  body.getReader = () => {
    const reader = getReader();
    const read = reader.read.bind(reader);
    const release = reader.releaseLock.bind(reader);
    reader.read = () => {
      const pending = read();
      reads++;
      for (const waiter of waiters) if (reads >= waiter.count) waiter.resolve();
      return pending;
    };
    reader.releaseLock = () => { releases++; return release(); };
    return reader;
  };
  return {
    response: { ok: true, status: 200, body }, body,
    push: value => controller.enqueue(frame(value)),
    pushRaw: value => controller.enqueue(encoder.encode(value)),
    close: () => controller.close(),
    error: () => controller.error(new Error('synthetic reader failure')),
    read: count => reads >= count ? Promise.resolve() : new Promise(resolve => waiters.push({ count, resolve })),
    get cancels() { return cancels; },
    get releases() { return releases; },
    cleanup() { try { controller.close(); } catch {} },
  };
}

function request(route, stream) {
  calls.length = 0;
  const output = [];
  const socket = new Duplex({ read() {}, write(_data, _encoding, done) { done(); } });
  const req = new IncomingMessage(socket);
  Object.assign(req, {
    method: 'POST', httpVersion: '1.1', httpVersionMajor: 1, httpVersionMinor: 1,
    complete: true, url: `/v1/${route}`,
    headers: { host: '127.0.0.1:39268', 'content-type': 'application/json' },
  });
  req.push(JSON.stringify({ model: 'trae/test', stream, input: 'hi', messages: [{ role: 'user', content: 'hi' }] }));
  req.push(null);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (data, ...rest) => { output.push(Buffer.from(data)); return write(data, ...rest); };
  res.end = (data, ...rest) => { if (data) output.push(Buffer.from(data)); return end(data, ...rest); };
  const finished = new Promise(resolve => res.once('finish', resolve));
  const closed = new Promise(resolve => res.once('close', resolve));
  const baselineCloseListeners = res.listenerCount('close');
  let error;
  const handled = context.bridgeHandle(req, res).catch(value => { error = value; });
  return {
    res, handled, finished,
    get output() { return Buffer.concat(output).toString('utf8'); },
    async cancel() { res.destroy(); await bounded(closed, 'response close'); },
    async settled() { await bounded(handled, 'handler exit'); assert.equal(error, undefined); },
    cleanListeners() {
      // The fixture's own once(close) listener is gone after close.
      assert.equal(res.listenerCount('close'), res.destroyed ? baselineCloseListeners - 1 : baselineCloseListeners);
    },
    cleanup() { socket.destroy(); },
  };
}
function assertCancelled(client, signal) {
  assert.ok(signal instanceof AbortSignal, 'fetch must receive the request AbortSignal');
  assert.equal(signal.aborted, true, 'client close must abort upstream');
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'abort listeners must be removed after handler exit');
  assert.doesNotMatch(client.output, /response\.(?:completed|incomplete)|message_stop|"status":"completed"/, 'cancellation must not emit success');
  client.cleanListeners();
}
function assertReader(upstream, cancels) {
  assert.equal(upstream.cancels, cancels, 'underlying stream cancel count');
  assert.equal(upstream.releases, 1, 'reader lock must be released once');
  assert.equal(upstream.body.locked, false);
}

let passed = 0;
let failed = 0;
async function test(label, run) {
  try { await run(); console.log(`ok ${++passed}. ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.stack}`); }
}
for (const route of ['responses', 'messages']) {
  for (const stream of [false, true]) {
    const label = `${route} ${stream ? 'SSE' : 'JSON'}`;
    for (const retry of [null, '11128', 'unsupported stream_options']) {
      await test(`${label} cancel ${retry ? `during retry (${retry})` : 'before headers'}`, async () => {
        const entered = deferred();
        const pending = deferred();
        let signal;
        respond = (options, count) => {
          if (retry && count === 1) return new Response(retry, { status: 400 });
          signal = options.signal;
          const abort = () => pending.reject(signal.reason);
          signal?.addEventListener('abort', abort, { once: true });
          entered.resolve();
          return pending.promise.finally(() => signal?.removeEventListener('abort', abort));
        };
        const client = request(route, stream);
        try {
          await bounded(entered.promise, 'fetch before headers');
          await client.cancel();
          await client.settled();
          assertCancelled(client, signal);
          client.cleanListeners();
          assert.equal(calls.length, retry ? 2 : 1);
          assert.ok(calls.every(call => call.signal === signal), 'all retries must share one signal');
        } finally {
          pending.reject(new Error('fixture cleanup'));
          await client.settled();
          client.cleanup();
        }
      });
    }
    for (const midText of [false, true]) {
      await test(`${label} cancel ${midText ? 'mid-text' : 'before first frame'}`, async () => {
        const upstream = streamResponse();
        respond = () => upstream.response;
        const client = request(route, stream);
        try {
          await bounded(upstream.read(1), 'first pending read');
          if (midText) {
            upstream.push(text);
            await bounded(upstream.read(2), 'next pending read');
            if (stream) assert.match(client.output, /partial answer/);
          }
          await client.cancel();
          await client.settled();
          assertCancelled(client, calls[0].signal);
          assertReader(upstream, 1);
        } finally { upstream.cleanup(); await client.settled(); client.cleanup(); }
      });
    }
    await test(`${label} normal finish/close does not abort`, async () => {
      const upstream = streamResponse();
      respond = () => upstream.response;
      const client = request(route, stream);
      try {
        await bounded(upstream.read(1), 'first read');
        upstream.push(text);
        upstream.push(stop);
        upstream.close();
        await client.settled();
        await bounded(client.finished, 'normal finish');
        assert.ok(calls[0].signal instanceof AbortSignal);
        assert.equal(calls[0].signal.aborted, false);
        assert.equal(getEventListeners(calls[0].signal, 'abort').length, 0);
        assertReader(upstream, 0);
        client.cleanListeners();
        client.res.emit('close');
        assert.equal(calls[0].signal.aborted, false, 'late close after success must not abort');
        assert.match(client.output, route === 'responses' ? /completed/ : /end_turn/);
      } finally { upstream.cleanup(); client.cleanup(); }
    });
    await test(`${label} DONE terminates while upstream transport remains open`, async () => {
      const upstream = streamResponse();
      respond = () => upstream.response;
      const client = request(route, stream);
      try {
        await bounded(upstream.read(1), 'first read');
        upstream.pushRaw('data:\n\n');
        await bounded(upstream.read(2), 'read after empty data');
        assert.equal(upstream.cancels, 0, 'empty data must not terminate the stream');
        upstream.push(text);
        upstream.push(stop);
        upstream.pushRaw('data: [DONE]\n\n');
        await client.settled();
        await bounded(client.finished, 'DONE response finish');
        assert.ok(calls[0].signal instanceof AbortSignal);
        assert.equal(calls[0].signal.aborted, false, 'protocol completion is not client cancellation');
        assert.equal(getEventListeners(calls[0].signal, 'abort').length, 0);
        assertReader(upstream, 1);
        client.cleanListeners();
        client.res.emit('close');
        assert.equal(calls[0].signal.aborted, false, 'late close after DONE must not abort');
        assert.match(client.output, /partial answer/);
        assert.match(client.output, route === 'responses' ? /completed/ : /end_turn/);
      } finally { upstream.cleanup(); await client.settled(); client.cleanup(); }
    });
    for (const failure of ['reader throws', 'upstream error frame', 'consumer throws']) {
      await test(`${label} ${failure} releases reader`, async () => {
        const upstream = streamResponse();
        respond = () => upstream.response;
        const client = request(route, stream);
        try {
          await bounded(upstream.read(1), 'first read');
          if (failure === 'reader throws') upstream.error();
          else if (failure === 'consumer throws') {
            // A malformed tool entry reaches the real builder and throws in the consumer.
            upstream.push({ choices: [{ delta: { tool_calls: [null] } }] });
          } else upstream.push({ error: { message: 'synthetic upstream failure', type: 'upstream_broken' } });
          await client.settled();
          await bounded(client.finished, 'error response finish');
          assertReader(upstream, failure === 'reader throws' ? 0 : 1);
          assert.equal(calls[0].signal.aborted, false, 'upstream failure is not client cancellation');
          assert.equal(getEventListeners(calls[0].signal, 'abort').length, 0);
          client.cleanListeners();
          assert.doesNotMatch(client.output, /response\.completed|message_stop/);
        } finally { upstream.cleanup(); await client.settled(); client.cleanup(); }
      });
    }
  }
}
console.log(`bridge R13 cancellation: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
