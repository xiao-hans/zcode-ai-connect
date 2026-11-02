// Offline R13 regressions: real Qwenwork wrapper, shim, signer and SSE reader.
// Only the credential boundary and upstream fetch are replaced.
// Usage: node --test tests/test-qwenwork-cancellation.mjs (Node >=22.15)
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { registerHooks } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test, after } from 'node:test'

const temp = await mkdtemp(fileURLToPath(new URL('../tmp/qwen-cancel-', import.meta.url)))
const envKeys = ['TMP', 'TEMP', 'TMPDIR', 'QWEN_INSTALL_DRIVES', 'QWEN_COSY_VERSION', 'QWEN_MACHINE_ID']
const envBefore = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
for (const key of ['TMP', 'TEMP', 'TMPDIR']) process.env[key] = temp
process.env.QWEN_INSTALL_DRIVES = 'none'
process.env.QWEN_COSY_VERSION = '1.1.32'
process.env.QWEN_MACHINE_ID = 'synthetic-machine'
assert.equal(tmpdir(), temp, 'shim trace must stay inside the test scratch directory')

const credentialUrl = new URL('../zcode-qwenwork-connect/vendor/lib/credentials-seam.js', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (new URL(specifier, context.parentURL).href === credentialUrl) {
      return { url: 'qwenwork-test:credential', shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'qwenwork-test:credential') {
      return { format: 'module', source: 'export async function getValidCredential() { return globalThis.__qwenworkTestCredential() }', shortCircuit: true }
    }
    return next(url, context)
  },
})
const { createQwenworkServer } = await import('../zcode-qwenwork-connect/src/server.js')
const fetchBefore = globalThis.fetch
const credential = { token: 'synthetic-token', loginDeviceId: 'synthetic-device', user: { id: 'synthetic-user' } }
const logger = { warn() {}, error() {}, info() {} }
const encoder = new TextEncoder()
const frame = (content, finish = null) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] }) })}\n\n`

after(async () => {
  globalThis.fetch = fetchBefore
  delete globalThis.__qwenworkTestCredential
  hooks.deregister()
  for (const key of envKeys) {
    if (envBefore[key] === undefined) delete process.env[key]
    else process.env[key] = envBefore[key]
  }
  await rm(temp, { recursive: true, force: true })
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function until(predicate, message) {
  const deadline = Date.now() + 700
  while (!predicate() && Date.now() < deadline) await delay(5)
  assert.ok(predicate(), message)
}

async function withServer(options, run) {
  const entered = deferred()
  const reading = deferred()
  const headers = deferred()
  let signal
  let controller
  let body
  let closed = false
  let calls = 0
  let fetchSettled = false
  let response
  let client
  let localResponse
  let closeListenersAtFinish
  const fixture = {
    entered: entered.promise,
    reading: reading.promise,
    releaseHeaders: () => headers.resolve(),
    get signal() { return signal },
    get body() { return body },
    get calls() { return calls },
    get fetchSettled() { return fetchSettled },
    get response() { return localResponse },
    get closeListenersAtFinish() { return closeListenersAtFinish },
    send(text) { controller.enqueue(encoder.encode(text)) },
    finish() { if (controller && !closed) { closed = true; controller.close() } },
    fail() { if (!closed) { closed = true; controller.error(new Error('synthetic reader failure')) } },
    disconnect() { client.destroy() },
  }
  const abortBody = () => {
    if (options.holdHeaders) headers.reject(signal.reason)
    if (!closed) {
      closed = true
      controller.error(new DOMException('The operation was aborted', 'AbortError'))
    }
  }
  globalThis.__qwenworkTestCredential = () => {
    if (options.credentialError) throw new Error('synthetic credential failure')
    return credential
  }
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(new URL(url).hostname, 'gateway.qwenwork.cn')
    assert.equal(init.method, 'POST')
    signal = init.signal
    body = new ReadableStream({
      start(value) { controller = value },
      pull() { reading.resolve() },
      cancel() { closed = true },
    })
    response = new Response(body, { status: options.status ?? 200 })
    signal.addEventListener('abort', abortBody, { once: true })
    entered.resolve()
    try {
      if (options.fetchError) throw new DOMException('synthetic fetch aborted', 'AbortError')
      if (options.holdHeaders) await headers.promise
      if (signal.aborted) throw signal.reason
      return response
    } finally {
      fetchSettled = true
    }
  }
  const endpoint = createQwenworkServer({ token: 'test-token', port: 0, logger })
  endpoint.server.prependListener('request', (_req, res) => {
    localResponse = res
    res.once('finish', () => { closeListenersAtFinish = res.listenerCount('close') })
  })
  try {
    await endpoint.start()
    const completed = new Promise((resolve, reject) => {
      client = request({
        hostname: '127.0.0.1', port: endpoint.server.address().port,
        path: '/v1/chat/completions', method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      }, res => {
        let text = ''
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
        res.on('error', reject)
      })
      client.on('error', reject)
      client.end(JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }], ...(options.omitStream ? {} : { stream: options.stream ?? false }) }))
    })
    // Cancellation cases intentionally destroy the client before it gets a response.
    completed.catch(() => {})
    await run(fixture, completed)
  } finally {
    headers.resolve()
    fixture.finish()
    client?.destroy()
    // Let the real shim unwind its reader and clear its watchdog before closing.
    try {
      if (body && (options.status ?? 200) === 200) await until(() => !body.locked, 'shim must release its upstream reader during cleanup')
    } finally {
      await endpoint.close()
      signal?.removeEventListener('abort', abortBody)
      globalThis.fetch = fetchBefore
    }
  }
}

test('non-streaming cancellation before upstream headers aborts the pending fetch promptly', async () => {
  await withServer({ holdHeaders: true }, async fixture => {
    await fixture.entered
    fixture.disconnect()
    await until(() => fixture.signal.aborted, 'client close must abort upstream while fetch is still waiting for headers')
  })
})

test('a disconnect before shim close subscription is remembered when headers arrive', async () => {
  await withServer({ holdHeaders: true }, async fixture => {
    await fixture.entered
    fixture.disconnect()
    await until(() => fixture.response.destroyed, 'server must observe client disconnect')
    fixture.releaseHeaders()
    await until(() => fixture.signal.aborted, 'late close subscriber must observe the earlier disconnect')
    await until(() => !fixture.body.locked, 'cancelled shim reader must be released')
    await until(() => fixture.response.listenerCount('close') === 0, 'cancelled capture must remove its response listener')
  })
})

for (const stage of ['before first frame', 'mid-text']) {
  test(`non-streaming cancellation ${stage} aborts upstream and releases reader`, async () => {
    await withServer({}, async fixture => {
      await fixture.entered
      await until(() => fixture.body.locked, 'real shim must start reading the upstream body')
      if (stage === 'mid-text') {
        fixture.send(frame('partial'))
        await fixture.reading
        await delay(10)
      }
      fixture.disconnect()
      await until(() => fixture.signal.aborted, 'client close must abort the upstream signal')
      await until(() => !fixture.body.locked, 'aborted upstream reader must be released')
      await until(() => fixture.response.listenerCount('close') === 0, 'cancelled capture must remove its response listener')
      assert.equal(fixture.calls, 1, 'cancellation must not trigger upstream retries')
    })
  })
}

for (const omitStream of [false, true]) {
  test(`normal non-streaming ${omitStream ? 'default' : 'explicit false'} completes without false cancellation`, async () => {
    await withServer({ omitStream }, async (fixture, completed) => {
      await fixture.entered
      fixture.send(frame('hello'))
      fixture.send(frame(' world', 'stop'))
      fixture.send('data: [DONE]\n\n')
      fixture.finish()
      const result = await completed
      assert.equal(result.status, 200)
      assert.match(result.headers['content-type'], /application\/json/)
      const body = JSON.parse(result.text)
      assert.equal(body.object, 'chat.completion')
      assert.equal(body.choices[0].message.content, 'hello world')
      assert.equal(body.choices[0].finish_reason, 'stop')
      await delay(10)
      assert.equal(fixture.signal.aborted, false, 'normal capture/HTTP completion must not abort upstream')
      assert.equal(fixture.closeListenersAtFinish, 0, 'capture close subscription must be removed before JSON completion')
      assert.equal(fixture.body.locked, false)
    })
  })
}

for (const kind of ['HTTP rejection', 'reader failure', 'fetch failure', 'credential failure']) {
  test(`non-streaming ${kind} keeps the error response and cleans listeners`, async () => {
    await withServer({ status: kind === 'HTTP rejection' ? 400 : 200, fetchError: kind === 'fetch failure', credentialError: kind === 'credential failure' }, async (fixture, completed) => {
      if (kind !== 'credential failure') await fixture.entered
      if (kind === 'HTTP rejection') {
        fixture.send('synthetic upstream rejection')
        fixture.finish()
      } else if (kind === 'reader failure') {
        await until(() => fixture.body.locked, 'shim must own the real upstream reader')
        fixture.send(frame('partial'))
        await delay(10)
        fixture.fail()
      }
      const result = await completed
      assert.equal(result.status, kind === 'HTTP rejection' ? 400 : kind === 'credential failure' ? 503 : 502)
      const body = JSON.parse(result.text)
      assert.ok(body.error)
      assert.equal(body.choices, undefined)
      assert.match(JSON.stringify(body.error), /synthetic/)
      assert.equal(fixture.closeListenersAtFinish, 0, 'capture subscription must be removed on every exit')
      assert.equal(fixture.signal?.aborted ?? false, false, 'normal error response must not be a client cancellation')
    })
  })
}

test('existing streaming path still delivers SSE normally', async () => {
  await withServer({ stream: true }, async (fixture, completed) => {
    await fixture.entered
    fixture.send(frame('streamed', 'stop'))
    fixture.send('data: [DONE]\n\n')
    fixture.finish()
    const result = await completed
    assert.equal(result.status, 200)
    assert.match(result.headers['content-type'], /text\/event-stream/)
    assert.match(result.text, /"content":"streamed"/)
    assert.equal(result.text.match(/data: \[DONE\]/g)?.length, 1)
    assert.equal(fixture.body.locked, false)
  })
})

test('existing streaming cancellation still aborts upstream and releases reader', async () => {
  await withServer({ stream: true }, async fixture => {
    await fixture.entered
    await until(() => fixture.body.locked, 'streaming shim must start reading')
    fixture.send(frame('partial'))
    await delay(10)
    fixture.disconnect()
    await until(() => fixture.signal.aborted, 'streaming disconnect must abort upstream')
    await until(() => !fixture.body.locked, 'streaming disconnect must release the reader')
  })
})
