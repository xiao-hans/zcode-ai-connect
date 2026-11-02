// Offline R03 regressions against the real loopback handlers and Qoder pump.
// Usage: node tests/test-upstream-errors.mjs
import assert from 'node:assert/strict'

process.env['ZC_STREAM_LOG'] = 'NUL'

const { createQoderServer } = await import('../zcode-qoder-connect/src/server.js')
const { createTraeServer } = await import('../zcode-trae-connect/src/server.js')
const { createWorkBuddyServer } = await import('../zcode-workbuddy-connect/src/server.js')
const { QoderUpstreamClient } = await import('../zcode-qoder-connect/src/upstream.js')

const logger = { log() {}, warn() {}, error() {} }
const catalog = { source: 'test', current: () => [], set() {}, setVisible() {}, isVisible: () => true }
const credential = { token: 'synthetic-token', userID: 'synthetic-user', authToken: 'synthetic-auth' }
const base = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }
const upstreamError = { message: 'synthetic upstream failure', type: 'upstream_error', code: 'E_TEST', detail: { retry: false } }
const frame = chunk => `data: ${JSON.stringify(chunk)}\n\n`
const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] })
const tool = { index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }
let passed = 0

function sseResponse(chunks, failure) {
  const encoder = new TextEncoder()
  let index = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]))
      else if (failure) controller.error(new Error(failure))
      else controller.close()
    },
  }))
}

async function withServer(create, fn) {
  let result
  const client = { chatStream: async () => result, fetchModels: async () => [] }
  const server = create({
    token: 'test-token', client, logger,
    variants: [{ id: 'cn', path: '', prefix: '', store: { resolve: async () => credential, status: async () => ({}) }, catalog, client }],
  })
  try {
    await server.start()
    await fn(async (response, stream = false) => {
      result = { ok: true, response }
      return fetch(`http://127.0.0.1:${server.port()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ ...base, stream }),
      })
    })
  } finally {
    await server.close()
  }
}

async function readJson(response, status) {
  assert.equal(response.status, status)
  assert.match(response.headers.get('content-type'), /application\/json/)
  return response.json()
}

async function readSse(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const text = await response.text()
  const payloads = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
  assert.equal(payloads.filter(value => value === '[DONE]').length, 1)
  const chunks = payloads.filter(value => value !== '[DONE]').map(value => JSON.parse(value))
  return {
    errors: chunks.filter(chunk => chunk.error).map(chunk => chunk.error),
    finishes: chunks.flatMap(chunk => chunk.choices ?? []).map(choice => choice.finish_reason).filter(Boolean),
    content: chunks.flatMap(chunk => chunk.choices ?? []).map(choice => choice.delta?.content ?? '').join(''),
    tools: chunks.flatMap(chunk => chunk.choices ?? []).flatMap(choice => choice.delta?.tool_calls ?? []),
  }
}

for (const [name, create] of [['qoder', createQoderServer], ['trae', createTraeServer], ['workbuddy', createWorkBuddyServer]]) {
  await withServer(create, async post => {
    for (const prefix of ['', frame(delta({ content: 'partial' }))]) {
      const response = sseResponse([prefix, frame({ error: upstreamError }), 'data: [DONE]\n\n'])
      const body = await readJson(await post(response), 502)
      assert.deepEqual(body, { error: upstreamError }, `${name}: preserve the original error, not a completion`)
      passed++
    }
    for (const chunks of [[], [frame(delta({ content: 'partial' }))]]) {
      const body = await readJson(await post(sseResponse(chunks, 'synthetic reader failure')), 502)
      assert.equal(body.error.type, 'upstream_stream_failed')
      assert.match(body.error.message, /synthetic reader failure/)
      assert.equal(body.choices, undefined)
      passed++
    }
    for (const [value, finish] of [[{ content: 'hello', reasoning_content: 'thinking' }, 'stop'], [{ tool_calls: [tool] }, 'tool_calls'], [{ content: 'partial' }, 'length']]) {
      const response = sseResponse([frame(delta(value)), frame({ ...delta({}, finish), usage: { total_tokens: 3 } }), 'data: [DONE]\n\n'])
      const body = await readJson(await post(response), 200)
      assert.equal(body.choices[0].finish_reason, finish)
      assert.deepEqual(body.usage, { total_tokens: 3 })
      if (value.tool_calls) {
        const { index, ...expected } = tool
        assert.deepEqual(body.choices[0].message.tool_calls, [expected])
      } else {
        assert.equal(body.choices[0].message.content, value.content)
        if (value.reasoning_content) assert.equal(body.choices[0].message.reasoning_content, value.reasoning_content)
      }
      passed++
    }
    console.log(`ok ${name}: 7 non-streaming error/reader/normal regressions`)
  })
}

await withServer(createQoderServer, async post => {
  for (const prefix of ['', frame(delta({ content: 'partial' }))]) {
    const result = await readSse(await post(sseResponse([prefix, frame({ error: upstreamError }), 'data: [DONE]\n\n']), true))
    assert.deepEqual(result.errors, [upstreamError])
    assert.deepEqual(result.finishes, ['network_error'])
    assert.equal(result.content, prefix ? 'partial' : '')
    passed++
  }
  for (const [value, finish] of [[{ content: 'hello' }, 'stop'], [{ tool_calls: [tool] }, 'tool_calls'], [{ content: 'partial' }, 'length']]) {
    const result = await readSse(await post(sseResponse([frame(delta(value)), frame(delta({}, finish)), 'data: [DONE]\n\n']), true))
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.finishes, [finish])
    if (value.tool_calls) assert.deepEqual(result.tools, [tool])
    else assert.equal(result.content, value.content)
    passed++
  }

  // The actual Qoder network reader throws after its first two-layer frame.
  // Its pump turns that throw into an error SSE frame consumed by server.js.
  for (const stream of [false, true]) {
    for (const content of ['', 'partial']) {
      const fetchBefore = globalThis.fetch
      let calls = 0
      let upstream
      try {
        globalThis.fetch = async (url, options) => {
          calls++
          assert.equal(new URL(url).hostname, 'synthetic.invalid')
          assert.equal(options.method, 'POST')
          return sseResponse([frame({ statusCodeValue: 200, body: JSON.stringify(delta({ content })) })], 'synthetic socket reset')
        }
        const client = new QoderUpstreamClient({ logger })
        client.urls = () => ({ chat: 'https://synthetic.invalid/chat' })
        upstream = await client.chatStream(credential, JSON.stringify(base))
        assert.equal(upstream.ok, true)
        assert.equal(calls, 1)
      } finally {
        globalThis.fetch = fetchBefore
      }
      const expected = { message: 'synthetic socket reset', type: 'upstream_error' }
      const response = await post(upstream.response, stream)
      if (stream) {
        const result = await readSse(response)
        assert.deepEqual(result.errors, [expected])
        assert.deepEqual(result.finishes, ['network_error'])
        assert.equal(result.content, content)
      } else {
        assert.deepEqual(await readJson(response, 502), { error: expected })
      }
      passed++
    }
  }
  console.log('ok qoder: 5 streaming regressions + 4 real upstream reader-error cases')
})

console.log(`all ${passed} upstream-error regressions passed`)
