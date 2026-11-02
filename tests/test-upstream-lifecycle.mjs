// Offline R11/R12 client regressions against the real upstream implementations.
// Usage: node --test tests/test-upstream-lifecycle.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

process.env['ZC_STREAM_LOG'] = 'NUL'
process.env['ZC_UPSTREAM_HEADER_TIMEOUT_MS'] = '35'
process.env['ZC_STREAM_IDLE_TIMEOUT_MS'] = '90'
const { QoderUpstreamClient } = await import('../zcode-qoder-connect/src/upstream.js')
const { llmChatStream } = await import('../zcode-trae-connect/src/llm-utils.js')

const credential = {
  token: 'synthetic-token', userId: 'synthetic-user',
  userID: 'synthetic-user', authToken: 'synthetic-auth', machineID: 'synthetic-machine',
}
const identity = { machineId: 'synthetic-machine', deviceId: 'synthetic-device', appVersion: 'test', versionCode: '20260716' }
const input = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const delta = (content, finish = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })
const qoder = new QoderUpstreamClient({ logger: { log() {}, warn() {}, error() {} } })
qoder.urls = () => ({ chat: 'https://synthetic.invalid/chat' })

const providers = [
  {
    name: 'qoder',
    chat: signal => qoder.chatStream(credential, JSON.stringify(input), signal),
    output: text => frame({ statusCodeValue: 200, body: JSON.stringify(delta(text)) }),
    terminal: frame({ statusCodeValue: 200, body: JSON.stringify(delta('', 'stop')) }),
    refusal: frame({ statusCodeValue: 503, body: 'synthetic gateway failure' }),
    ignored: frame({ statusCodeValue: 200, body: 'not JSON' }),
  },
  {
    name: 'trae',
    chat: signal => llmChatStream({ credential, identity, baseUrl: 'https://synthetic.invalid', openaiBody: input, signal }),
    output: text => `event: output\n${frame({ response: text })}`,
    terminal: `event: done\n${frame({ finish_reason: 'stop' })}`,
    refusal: `event: error\n${frame({ code: 503, message: 'synthetic gateway failure' })}`,
    ignored: `event: token_usage\n${frame({ total_tokens: 1 })}`,
  },
]

// The only network replacement: expose cancellation/locking of the raw fetch body.
function controlledResponse() {
  let controller
  let ended = false
  let cancels = 0
  let pulls = 0
  const body = new ReadableStream({
    start(value) { controller = value },
    pull() { pulls++ },
    cancel() { cancels++; ended = true },
  })
  const encoder = new TextEncoder()
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    body,
    get cancels() { return cancels },
    get pulls() { return pulls },
    send(text) { if (!ended) controller.enqueue(encoder.encode(text)) },
    close() { if (!ended) { ended = true; controller.close() } },
    fail(message) { if (!ended) { ended = true; controller.error(new Error(message)) } },
    cleanup() { if (!ended) { ended = true; controller.error(new Error('test cleanup')) } },
  }
}

async function bounded(promise, message, ms = 500) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function fixture(provider, run) {
  const fetchBefore = globalThis.fetch
  const raw = controlledResponse()
  const abort = new AbortController()
  const work = new Set()
  let signal
  let requests = 0
  const track = promise => { work.add(promise); promise.catch(() => {}); return promise }
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).hostname, 'synthetic.invalid')
      assert.equal(options.method, 'POST')
      requests++
      signal = options.signal
      return raw.response
    }
    await run({ raw, abort, track, chat: () => track(provider.chat(abort.signal)), get signal() { return signal } })
    assert.equal(requests, 1, 'no replay for successful or failed non-queue streams')
  } finally {
    abort.abort(new Error('test cleanup'))
    raw.cleanup()
    await Promise.allSettled([...work])
    globalThis.fetch = fetchBefore
  }
}

async function readSse(result) {
  assert.equal(result.ok, true, result.message)
  const text = await new Response(result.response.body).text()
  const payloads = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
  assert.equal(payloads.filter(value => value === '[DONE]').length, 1)
  const chunks = payloads.filter(value => value !== '[DONE]').map(value => JSON.parse(value))
  return {
    errors: chunks.filter(value => value.error).map(value => value.error),
    content: chunks.flatMap(value => value.choices ?? []).map(choice => choice.delta?.content ?? '').join(''),
    finishes: chunks.flatMap(value => value.choices ?? []).map(choice => choice.finish_reason).filter(Boolean),
  }
}

function released(raw, cancelled = true) {
  if (cancelled) assert.equal(raw.cancels, 1, 'the raw network stream must be cancelled, not just output DONE')
  assert.equal(raw.body.locked, false, 'the reader owner must release the raw stream lock')
}

for (const provider of providers) {
  for (const noise of ['silence', 'heartbeats', 'invalid frames', 'ignored records']) {
    test(`R11 ${provider.name}: ${noise} cannot keep first-frame wait alive`, async () => {
      await fixture(provider, async ({ raw, chat, track }) => {
        let interval
        try {
          const pending = chat()
          if (noise !== 'silence') {
            const data = noise === 'heartbeats' ? ': ping\n\n' : noise === 'invalid frames' ? 'data: {bad JSON}\n\n' : provider.ignored
            interval = setInterval(() => raw.send(data), 12)
          }
          const result = await bounded(pending, 'first-frame wait exceeded the configured idle budget')
          assert.equal(result.ok, false)
          assert.equal(result.kind, 'server')
          assert.match(result.message, /timeout|no .*frame/i)
          released(raw)
        } finally {
          clearInterval(interval)
        }
      })
    })
  }

  test(`R11 ${provider.name}: delayed first output and a long active stream survive both budgets`, async () => {
    await fixture(provider, async ({ raw, chat, track }) => {
      const pending = chat()
      await delay(55) // Header budget is over, but first-frame budget is not.
      raw.send(provider.output('0'))
      const result = await bounded(pending, 'first output was not handed off')
      const output = track(readSse(result))
      for (let i = 1; i <= 5; i++) {
        await delay(30)
        raw.send(provider.output(String(i)))
      }
      raw.send(provider.terminal) // Deliberately leave the raw socket open.
      assert.deepEqual(await bounded(output, 'active stream did not finish'), { errors: [], content: '012345', finishes: ['stop'] })
      released(raw)
    })
  })

  for (const consume of [false, true]) {
    test(`R12 ${provider.name}: terminal frame releases raw stream (${consume ? 'consumed' : 'unconsumed'} output)`, async () => {
      await fixture(provider, async ({ raw, chat, track }) => {
        raw.send(provider.output('hello') + provider.terminal)
        const result = await bounded(chat(), 'first output did not arrive')
        if (consume) {
          assert.deepEqual(await bounded(track(readSse(result)), 'terminal pump did not finish'), { errors: [], content: 'hello', finishes: ['stop'] })
        } else {
          await delay(10)
        }
        released(raw)
        const pulls = raw.pulls
        await delay(10)
        assert.equal(raw.pulls, pulls, 'pump must stop pulling after terminal cleanup')
      })
    })
  }

  for (const stage of ['before first output', 'during a pending read', 'while suspended at terminal']) {
    test(`R12 ${provider.name}: cancel ${stage} wakes the reader and finishes cleanup`, async () => {
      await fixture(provider, async (f) => {
        const pending = f.chat()
        if (stage === 'before first output') {
          await delay(5)
          f.abort.abort(new Error('synthetic caller abort'))
          const result = await bounded(pending, 'pre-output abort left chatStream pending')
          assert.equal(result.ok, false)
          assert.match(result.message, /synthetic caller abort/)
        } else {
          f.raw.send(provider.output('hello') + (stage === 'while suspended at terminal' ? provider.terminal : ''))
          const result = await bounded(pending, 'first output did not arrive')
          assert.equal(result.ok, true, result.message)
          await bounded(f.track(result.response.body.cancel('synthetic output cancel')), 'output cancel left the pump pending')
        }
        assert.equal(f.signal.aborted || stage === 'while suspended at terminal', true)
        released(f.raw)
      })
    })
  }

  for (const first of [true, false]) {
    test(`R12 ${provider.name}: socket error ${first ? 'before' : 'after'} first output is preserved and unlocks reader`, async () => {
      await fixture(provider, async ({ raw, chat, track }) => {
        const pending = chat()
        if (first) {
          raw.fail('synthetic socket reset')
          const result = await bounded(pending, 'reader error left chatStream pending')
          assert.equal(result.ok, false)
          assert.match(result.message, /synthetic socket reset/)
        } else {
          raw.send(provider.output('partial'))
          const result = await bounded(pending, 'first output did not arrive')
          const output = track(readSse(result))
          raw.fail('synthetic socket reset')
          const parsed = await bounded(output, 'reader error left pump pending')
          assert.match(parsed.errors[0]?.message ?? '', /synthetic socket reset/)
          assert.equal(parsed.content, 'partial')
          assert.ok(!parsed.finishes.includes('stop'))
        }
        released(raw, false) // An errored source cannot invoke underlying cancel().
      })
    })
  }

  for (const first of [true, false]) {
    test(`R12 ${provider.name}: gateway refusal ${first ? 'before' : 'after'} first output keeps its message and closes generator`, async () => {
      await fixture(provider, async ({ raw, chat, track }) => {
        raw.send((first ? '' : provider.output('partial')) + provider.refusal)
        const result = await bounded(chat(), 'refusal left chatStream pending')
        if (first) {
          assert.equal(result.ok, false)
          assert.match(result.message, /synthetic gateway failure/)
        } else {
          const output = await bounded(track(readSse(result)), 'refusal left pump pending')
          assert.match(output.errors[0]?.message ?? '', /synthetic gateway failure/)
          assert.ok(!output.finishes.includes('stop'))
        }
        released(raw)
      })
    })
  }

  test(`R12 ${provider.name}: normal EOF releases the reader without fabricating a full stop`, async () => {
    await fixture(provider, async ({ raw, chat, track }) => {
      raw.send(provider.output('partial'))
      raw.close()
      const parsed = await bounded(track(chat().then(readSse)), 'EOF left pump pending')
      assert.equal(parsed.content, 'partial')
      assert.deepEqual(parsed.finishes, ['length'])
      released(raw, false) // A closed source is already finished.
    })
  })
}
