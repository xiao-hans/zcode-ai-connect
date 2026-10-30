/**
 * Loopback OpenAI-compatible endpoint for the QwenWork (千问办公) upstream.
 *
 * The vendored chat shim (`vendor/lib/chat-shim.js`) already owns the hard
 * parts — credential refresh, WASM signing, upstream SSE translation, stream
 * termination semantics — but it listens on an OS-assigned port and knows one
 * route. This server mounts that handler on the suite's fixed port with the
 * two discovery routes a provider registration expects:
 *
 *   GET  /healthz              liveness probe (hook / pi-connect-services)
 *   GET  /v1/models            static roster (bearer-exempt, like the siblings)
 *   POST /v1/chat/completions  delegated to the vendored shim handler
 *
 * Chat stays behind the shim's own bearer check (the endpoint token, passed in
 * as the shim's shared secret), so authentication has exactly one source of
 * truth and the security boundary documented in the vendored code is unchanged.
 *
 * The request body is buffered once here and replayed into the shim through a
 * stream object, because the body must be parsed to learn `stream:false` while
 * the shim reads the request itself. Non-streaming calls are served through a
 * capturing response and reassembled into one `chat.completion` JSON — same
 * contract the trae/qoder servers implement. An error frame inside the
 * captured stream becomes a real HTTP 502; a silent empty completion would be
 * indistinguishable from a model that chose to say nothing.
 *
 * @module zcode-qwenwork-connect/server
 */

import { createServer } from 'node:http'
import { Readable } from 'node:stream'

import { createChatShimHandler } from '../vendor/lib/chat-shim.js'
import { getValidCredential } from '../vendor/lib/credentials-seam.js'
import { FALLBACK_QWENWORK_MODELS, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../vendor/lib/models.js'
import { hostIsLoopback, originIsLoopback } from '../vendor/lib/loopback.js'

/** Public ids a client sees: the display id where the roster declares one. */
const ROSTER = FALLBACK_QWENWORK_MODELS.map(model => ({
  id: model.displayNameId ?? model.id,
  name: model.shortName ?? model.displayNameId ?? model.id,
  rate: model.billingRate,
}))

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res, status, type, message) {
  writeJson(res, status, { error: { message, type } })
}

/** Read the whole request body with a size cap. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

/**
 * Minimal response sink for the non-streaming path. The shim handler only
 * touches `writeHead`, `write`, `end`, `on('close', …)` and `writableEnded`;
 * a client disconnect during a non-streaming call just means nobody reads the
 * capture, so the close listener is recorded and never fired.
 */
class CaptureResponse {
  constructor() {
    this.status = 0
    this.body = ''
    this.writableEnded = false
  }

  writeHead(status) {
    this.status = status
    return this
  }

  write(chunk) {
    this.body += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  }

  end(chunk) {
    if (chunk !== undefined) this.body += typeof chunk === 'string' ? chunk : String(chunk)
    this.writableEnded = true
  }

  on() {}
}

/**
 * Reassemble one captured OpenAI SSE stream into a single completion.
 *
 * Tool-call deltas are merged by index (ids and argument fragments arrive
 * spread across chunks). Any error frame turns the whole capture into a 502
 * carrying the upstream's own message — the shim formats in-stream errors as
 * `HTTP <code>: <message>` precisely so this layer can surface them verbatim.
 */
function collectCapturedCompletion(captured, fallbackModel) {
  if (captured.status !== 200) {
    const error = { message: captured.body || `upstream error (http ${captured.status})`, type: 'api_error' }
    return { ok: false, status: captured.status || 502, error }
  }

  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let usage
  let id = `chatcmpl-${Date.now()}`
  let created = Math.floor(Date.now() / 1000)
  const toolCalls = []
  let streamError = null

  for (const line of captured.body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    if (chunk['error'] !== undefined && chunk['error'] !== null) {
      streamError = chunk['error']
      continue
    }
    if (typeof chunk['id'] === 'string' && chunk['id'] !== '') id = chunk['id']
    if (typeof chunk['created'] === 'number') created = chunk['created']
    if (chunk['usage'] !== undefined && chunk['usage'] !== null) usage = chunk['usage']
    const choice = Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined
    if (choice === undefined) continue
    if (typeof choice['finish_reason'] === 'string' && choice['finish_reason'] !== '') {
      finishReason = choice['finish_reason']
    }
    const delta = choice['delta']
    if (typeof delta !== 'object' || delta === null) continue
    if (typeof delta['content'] === 'string') content += delta['content']
    if (typeof delta['reasoning_content'] === 'string') reasoning += delta['reasoning_content']
    if (Array.isArray(delta['tool_calls'])) {
      for (const call of delta['tool_calls']) {
        const index = call['index'] ?? 0
        const existing = toolCalls.find(c => c.index === index)
        if (!existing) {
          toolCalls.push({ index, id: call['id'] ?? '', name: call['function']?.['name'] ?? '', arguments: call['function']?.['arguments'] ?? '' })
        } else {
          if (call['id']) existing.id = call['id']
          if (call['function']?.['name']) existing.name += call['function']['name']
          if (call['function']?.['arguments']) existing.arguments += call['function']['arguments']
        }
      }
    }
  }

  if (streamError !== null) {
    return { ok: false, status: 502, error: streamError }
  }

  const message = { role: 'assistant', content: content === '' && toolCalls.length > 0 ? null : content }
  if (reasoning !== '') message['reasoning_content'] = reasoning
  if (toolCalls.length > 0) {
    message['tool_calls'] = toolCalls.map((call, i) => ({
      id: call.id || `call_${i}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
    if (finishReason === 'stop') finishReason = 'tool_calls'
  }
  const completion = { id, object: 'chat.completion', created, model: fallbackModel, choices: [{ index: 0, message, finish_reason: finishReason }] }
  if (usage !== undefined) completion['usage'] = usage
  return { ok: true, completion }
}

/**
 * Create the endpoint server (not yet listening).
 *
 * @param {object} options
 * @param {string} options.token bearer the shim requires on chat calls
 * @param {number} [options.port] fixed port for `start()`; default 39269
 * @param {object} [options.logger]
 */
export function createQwenworkServer(options) {
  const { token } = options
  const port = options.port ?? 39269
  const logger = options.logger ?? console

  // The shim owns chat authentication: the endpoint token doubles as the
  // shim's shared secret, so its constant-time check is the single gate.
  const chatHandler = createChatShimHandler({
    getCredential: () => getValidCredential(),
    sharedSecret: token,
    logger,
  })

  async function handle(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
      return
    }

    const path = (req.url ?? '/').split('?')[0]

    if (req.method === 'GET' && (path === '/healthz' || path === '/healthz/')) {
      writeJson(res, 200, { ok: true, provider: 'qwenwork', models: ROSTER.length })
      return
    }

    if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) {
      writeJson(res, 200, {
        object: 'list',
        data: ROSTER.map(model => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: 'qwenwork',
          context_window: MAX_INPUT_TOKENS,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          supports_images: true,
          display_name: model.name,
          billing_rate: model.rate,
        })),
      })
      return
    }

    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/chat/completions/')) {
      // OpenAI defaults `stream` to false when the key is absent. Defaulting to
      // true here silently turned every non-streaming caller (auxiliary clients:
      // title generation, smart approvals, probes) into an SSE consumer, so they
      // parsed a `data: {...}` text frame as the completion and failed with
      // "LLM returned invalid response (type=str)". Keep the spec default.
      let wantsStream = false
      let model = 'pro'
      let raw
      try {
        raw = await readBody(req)
        const text = raw.toString('utf8')
        const parsed = JSON.parse(text === '' ? '{}' : text)
        wantsStream = parsed?.['stream'] === true
        if (typeof parsed?.['model'] === 'string' && parsed['model'] !== '') model = parsed['model']
      } catch (error) {
        writeOpenAIError(res, 400, 'invalid_request_error', String(error?.message ?? error))
        return
      }

      // Replay the buffered body: the shim attaches its own data/end listeners,
      // which a consumed request would never satisfy.
      const replay = Readable.from([raw])
      replay.headers = req.headers
      replay.method = req.method
      replay.url = req.url

      if (wantsStream) {
        await chatHandler(replay, res)
        return
      }

      const captured = new CaptureResponse()
      await chatHandler(replay, captured)
      const result = collectCapturedCompletion(captured, model)
      if (result.ok) writeJson(res, 200, result.completion)
      else writeJson(res, result.status, { error: result.error })
      return
    }

    logger.warn(`[qwenwork] 404 ${req.method} ${path} host=${req.headers.host ?? '?'}`)
    writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${path}`)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) writeOpenAIError(res, 500, 'internal_error', String(error))
      else res.end()
    })
  })

  return {
    server,
    port,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
    },
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
