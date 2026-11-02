// Offline R06 regressions through the real Trae HTTP handler.
// Usage: node --test tests/test-trae-tool-aggregation.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

process.env['ZC_STREAM_LOG'] = 'NUL'
const { createTraeServer } = await import('../zcode-trae-connect/src/server.js')

const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] })
const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } })
const upstreamError = { message: 'synthetic upstream failure', type: 'upstream_error', code: 'E_R06' }

async function postCompletion(chunks, status = 200) {
  const encoder = new TextEncoder()
  let index = 0
  const client = {
    fetchModels: async () => [],
    chatStream: async () => ({
      ok: true,
      response: new Response(new ReadableStream({
        pull(controller) {
          if (index < chunks.length) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[index++])}\n\n`))
          } else {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        },
      })),
    }),
  }
  const server = createTraeServer({
    token: 'test-token', client,
    logger: { log() {}, warn() {}, error() {} },
    store: { resolve: async () => ({ token: 'synthetic-token' }) },
    catalog: { current: () => [], set() {}, setVisible() {} },
  })
  try {
    await server.start()
    const response = await fetch(`${server.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })
    assert.equal(response.status, status)
    assert.match(response.headers.get('content-type'), /application\/json/)
    return await response.json()
  } finally {
    await server.close()
  }
}

test('single tool arguments are assembled across SSE frames', async () => {
  const body = await postCompletion([
    { id: 'chatcmpl-r06', ...delta({ content: 'checking', reasoning_content: 'think ', tool_calls: [{ index: 0, ...tool('call_read', 'read_file', '{"path":') }] }) },
    delta({ reasoning_content: 'first', tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
    { ...delta({}, 'tool_calls'), usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } },
  ])
  assert.equal(body.id, 'chatcmpl-r06')
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.model, 'test-model')
  assert.deepEqual(body.choices, [{
    index: 0,
    message: { role: 'assistant', content: 'checking', reasoning_content: 'think first', tool_calls: [tool('call_read', 'read_file', '{"path":"a.txt"}')] },
    finish_reason: 'tool_calls',
  }])
  assert.deepEqual(body.usage, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 })
})

test('interleaved tools stay separate and are ordered by index', async () => {
  const body = await postCompletion([
    delta({ tool_calls: [{ index: 1, ...tool('call_b', 'write_file', '{"text":') }] }),
    delta({ tool_calls: [{ index: 0, ...tool('call_a', 'read_file', '{"path":') }] }),
    delta({ tool_calls: [
      { index: 1, function: { arguments: '"hello"}' } },
      { index: 0, function: { arguments: '"a.txt"}' } },
    ] }),
    delta({}, 'tool_calls'),
  ])
  assert.deepEqual(body.choices[0].message, {
    role: 'assistant', content: null,
    tool_calls: [tool('call_a', 'read_file', '{"path":"a.txt"}'), tool('call_b', 'write_file', '{"text":"hello"}')],
  })
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
})

test('later frames may omit id, type and name without losing earlier metadata', async () => {
  const body = await postCompletion([
    delta({ tool_calls: [{ index: 0, ...tool('call_run', 'run', '{"command":"') }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'echo ' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'ok"}' } }] }),
    delta({}, 'tool_calls'),
  ])
  assert.deepEqual(body.choices[0].message.tool_calls, [tool('call_run', 'run', '{"command":"echo ok"}')])
})

test('name and id can arrive after arguments without resetting them', async () => {
  const body = await postCompletion([
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
    delta({ tool_calls: [{ index: 0, id: 'call_late', type: 'function', function: { name: 'read_file' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"late.txt"}' } }] }),
    delta({}, 'tool_calls'),
  ])
  assert.deepEqual(body.choices[0].message.tool_calls, [tool('call_late', 'read_file', '{"path":"late.txt"}')])
})

for (const finish of ['stop', 'function_call', null, 'length']) {
  test(`tool completion finish_reason is consistent with upstream ${finish}`, async () => {
    const body = await postCompletion([
      delta({ tool_calls: [{ index: 0, ...tool('call_finish', 'read_file', '{}') }] }),
      delta({}, finish),
    ])
    assert.deepEqual(body.choices[0].message.tool_calls, [tool('call_finish', 'read_file', '{}')])
    assert.equal(body.choices[0].finish_reason, finish === 'length' ? 'length' : 'tool_calls')
  })
}

test('plain text, reasoning and usage remain unchanged', async () => {
  const body = await postCompletion([
    delta({ content: 'hello ', reasoning_content: 'think ' }),
    delta({ content: 'world', reasoning_content: 'more' }),
    { ...delta({}, 'stop'), usage: { total_tokens: 7 } },
  ])
  assert.deepEqual(body.choices, [{ index: 0, message: { role: 'assistant', content: 'hello world', reasoning_content: 'think more' }, finish_reason: 'stop' }])
  assert.deepEqual(body.usage, { total_tokens: 7 })
})

for (const partial of [false, true]) {
  test(`upstream error stays HTTP 502${partial ? ' after partial tool output' : ''}`, async () => {
    const chunks = partial ? [delta({ tool_calls: [{ index: 0, ...tool('call_error', 'read_file', '{') }] })] : []
    chunks.push({ error: upstreamError })
    assert.deepEqual(await postCompletion(chunks, 502), { error: upstreamError })
  })
}
