// test-stream-guard-qoder.mjs — the qoder endpoint's own normalizer.
//
// Its regression is specific: the normalizer used to carry only `content` and
// `reasoning_content`, so a tool_call delta never reached the client. The agent
// then received a turn that asked for a tool it would never get — it stops and
// the task stalls with no error anywhere.
//
// usage: ZC_STREAM_IDLE_TIMEOUT_MS=1200 node tests/test-stream-guard-qoder.mjs
import assert from 'node:assert/strict'

process.env['ZC_STREAM_IDLE_TIMEOUT_MS'] ??= '1200'

const { createQoderServer } = await import('../zcode-qoder-connect/src/server.js')

const silentLogger = { log() {}, warn() {}, error() {} }
const catalog = {
  source: 'test',
  fetchedAtMs: Date.now(),
  current: () => [],
  set() {},
  setVisible() {},
  isVisible: () => true,
}

function sseResponse(chunks, { endAfter = true } = {}) {
  const encoder = new TextEncoder()
  return {
    body: new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          if (typeof chunk === 'number') { await new Promise(r => setTimeout(r, chunk)); continue }
          controller.enqueue(encoder.encode(chunk))
        }
        if (endAfter) controller.close()
      },
    }),
  }
}

async function withServer(client, fn) {
  const server = createQoderServer({
    token: 'test-token',
    variants: [{ id: 'cn', path: '', prefix: '', store: { resolve: async () => ({ token: 't' }), status: async () => ({}) }, catalog, client }],
    logger: silentLogger,
  })
  await server.start()
  return fn(server)
}

const base = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }

async function post(server) {
  return await fetch(`http://127.0.0.1:${server.port()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(base),
  })
}

function parse(text) {
  const finishes = []
  const toolCalls = []
  let sawDone = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') { sawDone = true; continue }
    let chunk
    try { chunk = JSON.parse(payload) } catch { continue }
    const reason = chunk?.choices?.[0]?.finish_reason
    if (typeof reason === 'string' && reason !== '') finishes.push(reason)
    const calls = chunk?.choices?.[0]?.delta?.tool_calls
    if (Array.isArray(calls)) toolCalls.push(...calls)
  }
  return { finishes, toolCalls, sawDone }
}

// --- tool_call deltas must survive the normalizer ---------------------------
{
  const chunks = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"grep","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  ]
  const client = { chatStream: async () => ({ ok: true, response: sseResponse(chunks) }) }
  await withServer(client, async server => {
    const text = await (await post(server)).text()
    const { finishes, toolCalls } = parse(text)
    assert.equal(toolCalls.length, 1, 'tool_call deltas must reach the client')
    assert.equal(toolCalls[0].function.name, 'grep')
    assert.deepEqual(finishes, ['tool_calls'])
    await server.close()
    console.log('ok  1. qoder forwards tool calls')
  })
}

// --- a cut answer is not reported as a natural stop ------------------------
{
  const client = {
    chatStream: async () => ({
      ok: true,
      response: sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"部分"},"finish_reason":null}]}\n\n']),
    }),
  }
  await withServer(client, async server => {
    const { finishes, sawDone } = parse(await (await post(server)).text())
    assert.deepEqual(finishes, ['length'])
    assert.equal(sawDone, true)
    await server.close()
    console.log('ok  2. qoder marks a truncated stream as length')
  })
}

// --- a stalled upstream ends instead of hanging ---------------------------
{
  const client = {
    chatStream: async () => ({
      ok: true,
      response: sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"开头"},"finish_reason":null}]}\n\n', 30_000], { endAfter: false }),
    }),
  }
  await withServer(client, async server => {
    const started = Date.now()
    const { finishes, sawDone } = parse(await (await post(server)).text())
    assert.ok(finishes.includes('network_error'), `stall must end as network_error, got ${JSON.stringify(finishes)}`)
    assert.equal(sawDone, true)
    assert.ok(Date.now() - started < 15_000)
    await server.close()
    console.log('ok  3. qoder ends a stalled stream via the watchdog')
  })
}

console.log('all qoder stream-guard tests passed')
