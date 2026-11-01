// test-stream-guard.mjs — regression tests for the loopback stream guards.
//
// Covers the three failure modes that used to look like "the model suddenly
// stopped working":
//   1. upstream closes without a finish frame  → finish_reason "length", not a
//      fabricated "stop"
//   2. upstream goes silent mid-stream         → error frame + network_error +
//      [DONE] once the watchdog fires (never an endless open connection)
//   3. client disconnects                     → the upstream turn is aborted
//
// usage: ZC_STREAM_IDLE_TIMEOUT_MS=1200 node tests/test-stream-guard.mjs
import assert from 'node:assert/strict'

process.env['ZC_STREAM_IDLE_TIMEOUT_MS'] ??= '1200'
process.env['ZC_STREAM_TAIL_TIMEOUT_MS'] ??= '1200'

const { createTraeServer } = await import('../zcode-trae-connect/src/server.js')

const silentLogger = { log() {}, warn() {}, error() {} }

/** Minimal catalog the server's routes expect. */
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
          if (typeof chunk === 'number') {
            await new Promise(r => setTimeout(r, chunk))
            continue
          }
          controller.enqueue(encoder.encode(chunk))
        }
        if (endAfter) controller.close()
      },
    }),
  }
}

async function withServer(client, fn) {
  const server = createTraeServer({
    token: 'test-token',
    variants: [{ id: 'cn', path: '', prefix: '', store: { resolve: async () => ({ token: 't' }), status: async () => ({}) }, catalog, client }],
    logger: silentLogger,
  })
  await server.start()
  try {
    return await fn(server)
  } finally {
    /* each test closes its own server */
  }
}

/** Parse one SSE response into finish reasons + error frames. */
async function readSse(response) {
  const text = await response.text()
  const finishes = []
  const errors = []
  let sawDone = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') { sawDone = true; continue }
    let chunk
    try { chunk = JSON.parse(payload) } catch { continue }
    if (chunk?.error) errors.push(chunk.error)
    const reason = chunk?.choices?.[0]?.finish_reason
    if (typeof reason === 'string' && reason !== '') finishes.push(reason)
  }
  return { finishes, errors, sawDone }
}

async function post(server, body) {
  return await fetch(`http://127.0.0.1:${server.port()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  })
}

const base = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }

// --- 1. answers cut off without a finish frame ------------------------------
{
  const client = {
    chatStream: async () => ({
      ok: true,
      response: sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"部分"},"finish_reason":null}]}\n\n']),
    }),
  }
  await withServer(client, async server => {
    const res = await post(server, base)
    const { finishes, sawDone } = await readSse(res)
    assert.deepEqual(finishes, ['length'], `truncated stream must close as length, got ${JSON.stringify(finishes)}`)
    assert.equal(sawDone, true, 'stream must still terminate with [DONE]')
    await server.close()
    console.log('ok  1. truncated stream closes as finish_reason=length')
  })
}

// --- 2. upstream stalls after the first tokens ------------------------------
{
  const client = {
    chatStream: async () => ({
      ok: true,
      response: sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"开头"},"finish_reason":null}]}\n\n', 30_000], { endAfter: false }),
    }),
  }
  await withServer(client, async server => {
    const started = Date.now()
    const res = await post(server, base)
    const { finishes, errors, sawDone } = await readSse(res)
    assert.equal(errors.length, 1, 'a stall must be reported as an error frame')
    assert.equal(errors[0].type, 'upstream_stalled')
    assert.ok(finishes.includes('network_error'), `stall finish must be network_error, got ${JSON.stringify(finishes)}`)
    assert.equal(sawDone, true)
    assert.ok(Date.now() - started < 15_000, 'watchdog must fire instead of hanging')
    await server.close()
    console.log('ok  2. silent upstream is ended by the idle watchdog')
  })
}

// --- 3. client disconnect releases the upstream turn ------------------------
{
  let upstreamSignal
  let aborted = false
  const client = {
    chatStream: async (_credential, _body, signal) => {
      upstreamSignal = signal
      signal.addEventListener('abort', () => { aborted = true })
      return {
        ok: true,
        // Never produces anything, never closes: only the abort can end it.
        response: { body: new ReadableStream({ start() {} }) },
      }
    },
  }
  await withServer(client, async server => {
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${server.port()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify(base),
      signal: controller.signal,
    }).catch(() => undefined)
    await new Promise(r => setTimeout(r, 300))
    controller.abort()
    await pending
    await new Promise(r => setTimeout(r, 200))
    assert.equal(aborted, true, 'client disconnect must abort the upstream signal')
    assert.equal(upstreamSignal.aborted, true)
    await server.close()
    console.log('ok  3. client disconnect aborts the upstream turn')
  })
}

// --- 4. tool-call turn labelled `stop` reaches the client as tool_calls -----
{
  const chunks = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ]
  const client = { chatStream: async () => ({ ok: true, response: sseResponse(chunks) }) }
  await withServer(client, async server => {
    const res = await post(server, base)
    const text = await res.text()
    const { finishes } = await readSse(new Response(text))
    assert.deepEqual(finishes, ['tool_calls'], `tool-call turn must report tool_calls, got ${JSON.stringify(finishes)}`)
    assert.ok(text.includes('"name":"read"'), 'the tool call itself must reach the client')
    await server.close()
    console.log('ok  4. tool-call turn reports finish_reason=tool_calls')
  })
}

// --- 5. omitted `stream` must default to non-streaming JSON -----------------
// OpenAI defaults `stream` to false. Defaulting to true broke every auxiliary
// client that omits the key (Hermes title generation / smart approvals): it
// received `data: {...}` SSE text and failed with
// "LLM returned invalid response (type=str)".
{
  const chunks = [
    'data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ]
  const client = { chatStream: async () => ({ ok: true, response: sseResponse(chunks) }) }
  await withServer(client, async server => {
    const res = await post(server, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    const contentType = res.headers.get('content-type') ?? ''
    assert.ok(contentType.includes('application/json'), `omitted stream must yield JSON, got ${contentType}`)
    const body = await res.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.content, '你好')
    await server.close()
    console.log('ok  5. omitted stream defaults to a JSON completion')
  })
}

// --- 6. upstream goes silent AFTER the answer body (tail timeout) -----------
// 实测(2026-11-01 21:38:09 → 21:41:10,trae/deepseek-v4.1-flash):正文写完,
// 上游既不发 done 也不关连接。旧的单一 180s 看门狗在 3 分钟后补一个 error 帧,
// 宿主看到 "Server error mid-response",一整轮已产出的内容被判失败。
// 正文已出 → 短宽限 + 按截断(length)收尾:客户端知道"写了一半",不是整轮挂掉。
{
  const chunks = [
    'data: {"choices":[{"index":0,"delta":{"content":"签名"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"失败。"},"finish_reason":null}]}\n\n',
    30_000,
  ]
  const client = {
    chatStream: async () => ({ ok: true, response: sseResponse(chunks, { endAfter: false }) }),
  }
  await withServer(client, async server => {
    const started = Date.now()
    const res = await post(server, base)
    const { finishes, errors, sawDone } = await readSse(res)
    assert.deepEqual(finishes, ['length'], `post-content stall must close as length, got ${JSON.stringify(finishes)}`)
    assert.equal(errors.length, 0, 'a turn that already produced content must NOT be reported as an error')
    assert.equal(sawDone, true)
    assert.ok(Date.now() - started < 10_000, 'the tail watchdog must fire on the short budget, not the 180s one')
    await server.close()
    console.log('ok  6. silent upstream after the body closes as length (tail timeout)')
  })
}

console.log('all stream-guard tests passed')
