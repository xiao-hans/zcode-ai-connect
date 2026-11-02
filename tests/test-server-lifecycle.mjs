// Offline R12 regressions against the real loopback handlers.
// Usage: node --test tests/test-server-lifecycle.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'

process.env['ZC_STREAM_LOG'] = 'NUL'
process.env['ZC_STREAM_IDLE_TIMEOUT_MS'] = '500'
process.env['ZC_STREAM_TAIL_TIMEOUT_MS'] = '500'

const { createQoderServer } = await import('../zcode-qoder-connect/src/server.js')
const { createTraeServer } = await import('../zcode-trae-connect/src/server.js')
const { createWorkBuddyServer } = await import('../zcode-workbuddy-connect/src/server.js')
const frame = chunk => `data: ${JSON.stringify(chunk)}\n\n`
const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] })
const upstreamError = { message: 'synthetic R12 failure', type: 'upstream_error', code: 'E_R12' }

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function until(predicate, message) {
  const deadline = Date.now() + 1500
  while (!predicate() && Date.now() < deadline) await delay(5)
  assert.ok(predicate(), message)
}

function controlledUpstream(chunks = [], ending = 'open', { cancelError = false } = {}) {
  const stopped = deferred()
  const state = { cancels: 0, cancelCalls: 0, releases: 0, pendingReads: 0, pumpEnded: false, cancelEnded: false }
  let source
  const body = new ReadableStream({
    start(controller) { source = controller },
    async cancel() {
      state.cancels++
      // Make cancellation asynchronous: releasing the lock is not enough.
      await nextTurn()
      stopped.resolve()
      await pump
      state.cancelEnded = true
      if (cancelError) throw new Error('synthetic R12 cancel failure')
    },
  })
  const pump = (async () => {
    await nextTurn()
    for (const chunk of chunks) source.enqueue(new TextEncoder().encode(chunk))
    if (ending === 'eof') source.close()
    else if (ending === 'error') source.error(new Error('synthetic R12 reader failure'))
    else await stopped.promise
    state.pumpEnded = true
  })()
  const nativeGetReader = body.getReader.bind(body)
  body.getReader = (...args) => {
    const reader = nativeGetReader(...args)
    const read = reader.read.bind(reader)
    const cancel = reader.cancel.bind(reader)
    const release = reader.releaseLock.bind(reader)
    reader.read = async () => {
      state.pendingReads++
      try { return await read() } finally { state.pendingReads-- }
    }
    reader.cancel = (...values) => { state.cancelCalls++; return cancel(...values) }
    reader.releaseLock = () => { release(); state.releases++ }
    return reader
  }
  return {
    body, state, response: new Response(body),
    async cleanup() {
      stopped.resolve()
      try { source.error(new Error('test cleanup')) } catch { /* already closed */ }
      await pump
      await nextTurn()
    },
  }
}

async function withServer(create, upstream, run, { holdResult = false } = {}) {
  const called = deferred()
  const resultReady = deferred()
  const warnings = []
  let signal
  const client = {
    fetchModels: async () => [], fetchCredits: async () => ({}),
    async chatStream(_credential, _body, abortSignal) {
      signal = abortSignal
      called.resolve()
      if (holdResult) await resultReady.promise
      return { ok: true, response: upstream.response }
    },
  }
  const server = create({
    token: 'test-token', client,
    logger: { log() {}, warn(message) { warnings.push(message) }, error() {} },
    store: { resolve: async () => ({ token: 'synthetic-token' }) },
    catalog: { current: () => [], set() {}, setVisible() {}, isVisible: () => true },
  })
  try {
    await server.start()
    await run({
      called: called.promise, resultReady, warnings, signal: () => signal,
      post(stream, abortSignal = AbortSignal.timeout(2500)) {
        return fetch(`${server.baseUrl()}/v1/chat/completions`, {
          method: 'POST', signal: abortSignal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
          body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream }),
        })
      },
    })
  } finally {
    resultReady.resolve()
    await server.close()
    await upstream.cleanup()
  }
}

async function assertReleased(upstream, cancels) {
  await until(() => upstream.state.releases === 1, 'handler must release its reader and finish cleanup')
  assert.equal(upstream.body.locked, false)
  assert.equal(upstream.state.pendingReads, 0, 'no read remains pending')
  assert.equal(upstream.state.cancels, cancels, 'cancel the underlying source exactly once when still open')
  assert.ok(upstream.state.cancelCalls <= 1, 'abort and finally must share one cancellation')
  assert.equal(upstream.state.pumpEnded, true, 'the synthetic upstream pump must actually end')
  if (cancels) assert.equal(upstream.state.cancelEnded, true, 'await cancellation before releasing the lock')
}

for (const [name, create] of [['qoder', createQoderServer], ['trae', createTraeServer], ['workbuddy', createWorkBuddyServer]]) {
  for (const stream of [false, true]) {
    const mode = stream ? 'SSE' : 'JSON'
    test(`${name} ${mode}: DONE releases an upstream that stays open`, { timeout: 5000 }, async () => {
      const upstream = controlledUpstream([frame(delta({ content: 'hello' })), 'data: [DONE]\n\n'])
      await withServer(create, upstream, async ({ post, signal, warnings }) => {
        const response = await post(stream, AbortSignal.timeout(2500))
        const text = await response.text()
        assert.equal(response.status, 200)
        if (stream) assert.match(text, /data: \[DONE\]/)
        else assert.equal(JSON.parse(text).choices[0].message.content, 'hello')
        await assertReleased(upstream, 1)
        assert.equal(signal().aborted, false, 'normal response finish is not a disconnect')
        assert.equal(warnings.some(line => /client disconnected/.test(line)), false)
      })
    })

    test(`${name} ${mode}: natural EOF releases without source cancellation`, { timeout: 5000 }, async () => {
      const upstream = controlledUpstream([frame(delta({ content: 'hello' }))], 'eof')
      await withServer(create, upstream, async ({ post, signal }) => {
        const response = await post(stream)
        await response.text()
        assert.equal(response.status, 200)
        await assertReleased(upstream, 0)
        assert.equal(signal().aborted, false)
      })
    })

    test(`${name} ${mode}: reader failure releases without hiding the error`, { timeout: 5000 }, async () => {
      const upstream = controlledUpstream([], 'error')
      await withServer(create, upstream, async ({ post, warnings }) => {
        const response = await post(stream)
        const text = await response.text()
        if (stream) {
          assert.match(text, /data: \[DONE\]/)
          assert.ok(warnings.some(line => /synthetic R12 reader failure/.test(line)))
        } else {
          assert.equal(response.status, 502)
          assert.equal(JSON.parse(text).error.type, 'upstream_stream_failed')
          assert.match(JSON.parse(text).error.message, /synthetic R12 reader failure/)
        }
        await assertReleased(upstream, 0)
      })
    })

    test(`${name} ${mode}: disconnect before the first frame ends the pending read`, { timeout: 5000 }, async () => {
      const upstream = controlledUpstream()
      await withServer(create, upstream, async ({ post, called, signal }) => {
        const controller = new AbortController()
        const pending = post(stream, controller.signal).catch(error => error)
        await called
        await until(() => upstream.state.pendingReads > 0, 'handler must be waiting for its first frame')
        controller.abort()
        await pending
        await until(() => signal().aborted, 'disconnect must abort the upstream signal')
        await assertReleased(upstream, 1)
      })
    })

    test(`${name} ${mode}: disconnect while awaiting upstream acquisition releases the late reader`, { timeout: 5000 }, async () => {
      const upstream = controlledUpstream()
      await withServer(create, upstream, async ({ post, called, signal, resultReady }) => {
        const controller = new AbortController()
        const pending = post(stream, controller.signal).catch(error => error)
        await called
        controller.abort()
        await pending
        await until(() => signal().aborted, 'disconnect must be observed before acquisition completes')
        resultReady.resolve()
        await assertReleased(upstream, 1)
      }, { holdResult: true })
    })
  }

  test(`${name} SSE: finish frame breaks early and cancels exactly once`, { timeout: 5000 }, async () => {
    const upstream = controlledUpstream([frame(delta({ content: 'hello' })), frame(delta({}, 'stop'))])
    await withServer(create, upstream, async ({ post }) => {
      assert.match(await (await post(true)).text(), /data: \[DONE\]/)
      await assertReleased(upstream, 1)
    })
  })

  test(`${name} JSON: an upstream error frame releases without waiting for EOF`, { timeout: 5000 }, async () => {
    const upstream = controlledUpstream([frame({ error: upstreamError })])
    await withServer(create, upstream, async ({ post }) => {
      const response = await post(false, AbortSignal.timeout(2500))
      assert.equal(response.status, 502)
      assert.deepEqual(await response.json(), { error: upstreamError })
      await assertReleased(upstream, 1)
    })
  })

  test(`${name} SSE: explicit downstream reader cancellation stops the pump`, { timeout: 5000 }, async () => {
    const upstream = controlledUpstream([frame(delta({ reasoning_content: 'thinking' }))])
    await withServer(create, upstream, async ({ post, signal }) => {
      const response = await post(true)
      const reader = response.body.getReader()
      try {
        assert.equal((await reader.read()).done, false)
        await reader.cancel('synthetic client cancel')
      } finally { reader.releaseLock() }
      await assertReleased(upstream, 1)
      assert.equal(signal().aborted, true)
    })
  })

  test(`${name} SSE: idle watchdog cancels a reader even if upstream ignores the signal`, { timeout: 5000 }, async () => {
    const upstream = controlledUpstream()
    await withServer(create, upstream, async ({ post, signal }) => {
      const text = await (await post(true)).text()
      assert.match(text, /upstream_stalled/)
      assert.match(text, /data: \[DONE\]/)
      await assertReleased(upstream, 1)
      assert.equal(signal().aborted, true)
    })
  })
}
