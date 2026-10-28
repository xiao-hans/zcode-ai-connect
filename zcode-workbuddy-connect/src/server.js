/**
 * Loopback OpenAI-compatible endpoint.
 *
 * A client points an `openai-chat-completions` provider at this server; the
 * server applies the WorkBuddy wire quirks (forced streaming, string
 * `tool_choice`, desktop-shaped headers) and forwards to the real upstream.
 * It binds 127.0.0.1 only and never serves another interface.
 *
 * Inbound hardening: the loopback bind alone is not a trust boundary (any
 * local process, and a DNS-rebinding page, can reach 127.0.0.1), so every
 * request must carry a loopback Host header, browser-sent Origins must be
 * loopback, chat POSTs must be application/json, and the Authorization header
 * must carry this server's configured bearer.
 *
 * @module zcode-workbuddy-connect/server
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hostIsLoopback, originIsLoopback } from './loopback.js'
import { prepareChatBody, WorkBuddyUpstreamClient } from './upstream.js'

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024
const CATALOG_REFRESH_MS = 30 * 60 * 1000
/** SSE comment cadence during upstream silence, well under any read timeout. */
const HEARTBEAT_MS = 10_000
/**
 * Total upstream silence tolerated before the turn is given up.
 *
 * Heartbeats keep the client's read timer alive, which is exactly what hides a
 * dead upstream: the socket stays open, the client keeps waiting, nothing ever
 * ends — the "model just stopped moving" report. A multi-minute silence on an
 * already-open stream is a stall, not a slow model.
 */
const STREAM_IDLE_TIMEOUT_MS = Number(process.env['ZC_STREAM_IDLE_TIMEOUT_MS'] ?? 180_000)

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function isJsonContentType(req) {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** Constant-time bearer check; absent or mismatched bearers are rejected. */
function bearerOk(req, expected) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null) return false
  const a = Buffer.from(match[1])
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Buffer an upstream SSE stream into one non-streaming completion.
 *
 * The upstream rejects `stream: false` outright, so a client that asked for a
 * single JSON answer is served by consuming the stream here and reassembling
 * it. Content, tool-call fragments and reasoning are all merged by index,
 * matching the OpenAI chunking shape.
 */
async function collectCompletion(body, model) {
  const text = await new Response(body).text()
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let usage
  let id = `chatcmpl-${Date.now()}`
  const toolCalls = new Map()

  for (const line of text.split('\n')) {
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
    if (typeof chunk['id'] === 'string' && chunk['id'] !== '') id = chunk['id']
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
    if (Array.isArray(delta['tool_calls'])) mergeToolCalls(toolCalls, delta['tool_calls'])
  }

  const message = { role: 'assistant', content: content === '' ? null : content }
  if (reasoning !== '') message['reasoning_content'] = reasoning
  const completed = completeToolCalls(toolCalls)
  if (completed.length > 0) {
    message['tool_calls'] = completed.map(call => ({
      id: call.id,
      type: call.type,
      function: call.function,
    }))
    if (finishReason === 'stop' || finishReason === 'function_call') finishReason = 'tool_calls'
  }
  const completion = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  }
  if (usage !== undefined) completion['usage'] = usage
  return completion
}

/**
 * Merge upstream tool-call fragments into complete calls.
 *
 * The upstream streams arguments in ~5-character pieces and is *not*
 * idempotent about the fields around them: `id`, `type` and `function.name`
 * appear in the FIRST fragment only, and every later fragment omits them while
 * repeating `index`. A client that appends per chunk the obvious way therefore
 * ends up with a nameless, id-less call. Fragments are keyed by `index` and
 * merged here instead, so the caller sees one complete call per index.
 */
function mergeToolCalls(accumulator, fragments) {
  for (const call of fragments) {
    if (typeof call !== 'object' || call === null) continue
    const index = typeof call['index'] === 'number' ? call['index'] : 0
    const existing = accumulator.get(index) ?? { id: '', name: '', arguments: '' }
    if (typeof call['id'] === 'string' && call['id'] !== '') existing.id = call['id']
    const fn = call['function']
    if (typeof fn === 'object' && fn !== null) {
      if (typeof fn['name'] === 'string' && fn['name'] !== '') existing.name = fn['name']
      if (typeof fn['arguments'] === 'string') existing.arguments += fn['arguments']
    }
    accumulator.set(index, existing)
  }
}

function completeToolCalls(accumulator) {
  return [...accumulator.entries()]
    .sort((a, b) => a[0] - b[0])
    // A nameless call is worse than a missing one: the client stores it in
    // history, and every later turn then fails upstream with 400 code 11133
    // ("the request parameters were rejected") — deepseek's provider rejects
    // `name: ""` outright. A truncated stream can produce one; drop it.
    .filter(([, call]) => call.name !== '')
    .map(([index, call]) => ({
      index,
      id: call.id === '' ? `call_${Math.random().toString(36).slice(2, 11)}` : call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
}


/** Diagnostics: the service runs detached, so stdout goes nowhere. */
const STREAM_LOG_PATH = process.env['ZC_STREAM_LOG'] ?? join(homedir(), '.zcode-workbuddy-connect', 'stream.log')

/** Append one diagnostics line; logging must never break a request. */
function diag(line) {
  try {
    appendFileSync(STREAM_LOG_PATH, `${new Date().toISOString()} workbuddy ${line}
`)
  } catch {
    /* best effort */
  }
}

/**
 * Drop assistant messages that carry neither text nor tool calls.
 *
 * Upstream validators reject such a message outright (Trae answers 4001 / HTTP 400
 * on EVERY request carrying it), and the client stores the empty assistant message
 * in its session and sends it back next turn — one interrupted turn therefore
 * poisons the whole session. A real session accumulated 154 of them and could not
 * send another message.
 *
 * @param {string} bodyJson raw request body
 * @returns {{ body: string, dropped: number }}
 */
function sanitizeHistory(bodyJson) {
  let parsed
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return { body: bodyJson, dropped: 0 }
  }
  if (!Array.isArray(parsed?.messages)) return { body: bodyJson, dropped: 0 }
  const before = parsed.messages.length
  const messages = parsed.messages.filter((message) => {
    if (message?.role !== 'assistant') return true
    const content = message.content
    const hasText = typeof content === 'string'
      ? content.trim() !== ''
      : Array.isArray(content) && content.some((block) => String(block?.text ?? block?.content ?? '').length > 0)
    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls.length
      : Array.isArray(message.function_call) ? message.function_call.length : 0
    return hasText || calls > 0
  })
  const dropped = before - messages.length
  if (dropped === 0) return { body: bodyJson, dropped: 0 }
  parsed.messages = messages
  return { body: JSON.stringify(parsed), dropped }
}

/**
 * Proxy an upstream SSE stream into clean OpenAI chunks.
 *
 * Content and `reasoning_content` deltas are forwarded immediately so the
 * caller streams token-by-token; tool-call fragments are buffered and emitted
 * once as complete calls (see {@link mergeToolCalls}); usage and finish
 * reasons pass through unchanged.
 *
 * Heartbeats: reasoning models can think for minutes before emitting a single
 * token, and the upstream pads that silence with SSE comment lines. Comments
 * are not forwarded (they carry nothing), but the silence must not be passed
 * on either — a client whose read timeout is shorter than the thinking time
 * would abort a request that is still working. An SSE comment is emitted
 * locally every {@link HEARTBEAT_MS} of silence instead: every SSE client
 * ignores comment lines, so this keeps intermediaries and read timers alive
 * without inventing protocol events.
 */
function createStreamNormalizer(res, fallbackModel, { logger, onStall } = {}) {
  const pending = new Map()
  let model = fallbackModel
  let id = `chatcmpl-${Date.now()}`
  let created = Math.floor(Date.now() / 1000)
  let toolCallsSent = false
  let done = false
  let settled = false
  let heartbeat
  let idleTimer
  // Reasoning-order guarantee: a client pins the thinking panel at the slot
  // where the FIRST reasoning delta arrives, so the first content delta is
  // held until the order is known - either reasoning shows up (the held
  // content is released behind it) or a second content delta proves the
  // stream is plain text and the held chunk goes out as-is. Reasoning
  // that trails the answer is buffered and flushed before the finish
  // frame, so reasoning and content never interleave on the wire.
  let reasoningStarted = false
  let contentStarted = false
  let heldContent = null
  let lateReasoning = ''

  const bumpHeartbeat = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = setInterval(() => {
      if (res.writable && !done) res.write(': heartbeat\n\n')
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
  }

  const write = payload => {
    if (!res.writable || done) return
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  /**
   * Upstream-liveness watchdog. Re-armed on every upstream byte only, so our
   * own heartbeats cannot keep it quiet — the whole point is to notice an
   * upstream that went silent while the client is still waiting.
   */
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (done || settled) return
      logger?.warn?.(`[workbuddy] upstream silent for ${STREAM_IDLE_TIMEOUT_MS}ms — aborting the turn`)
      write({
        error: {
          message: `upstream produced no data for ${STREAM_IDLE_TIMEOUT_MS}ms`,
          type: 'upstream_stalled',
          code: 'upstream_stalled',
        },
      })
      emitToolCallsAndFinish('network_error')
      done = true
      if (res.writable) res.end('data: [DONE]\n\n')
      onStall?.()
    }, STREAM_IDLE_TIMEOUT_MS)
    idleTimer.unref?.()
  }

  bumpHeartbeat()
  armIdle()

  const emitDelta = carry => {
    write({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', ...carry }, finish_reason: null }],
    })
  }

  const emitContent = text => {
    contentStarted = true
    emitDelta({ content: text })
  }

  /** Release the held content delta, behind any reasoning already emitted. */
  const flushHeldContent = () => {
    if (heldContent === null) return
    const text = heldContent
    heldContent = null
    emitContent(text)
  }

  /** Reasoning that arrived after the answer began goes out just before finish. */
  const flushLateReasoning = () => {
    if (lateReasoning === '') return
    const carry = { reasoning_content: lateReasoning }
    lateReasoning = ''
    emitDelta(carry)
  }

  const emitToolCallsAndFinish = finishReason => {
    if (settled) return
    settled = true
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    flushHeldContent()
    flushLateReasoning()
    const calls = completeToolCalls(pending)
    if (calls.length > 0) {
      toolCallsSent = true
      write({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: null }],
      })
    }
    // A finish that promises tool calls but delivered none (every pending
    // call was nameless and dropped) must not reach the client as
    // `finish_reason: "tool_calls"` — a turn that ends on that contract
    // without any call derails the client's loop. The mirror case matters as
    // much: calls that DID go out must not be reported as `stop`.
    const wireFinish = toolCallsSent
      ? (finishReason === 'stop' || finishReason === 'end' ? 'tool_calls' : finishReason)
      : (finishReason === 'tool_calls' || finishReason === 'function_call') ? 'stop'
      : finishReason
    write({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: wireFinish }],
    })
  }

  /** Handle one parsed upstream chunk. Returns true once the stream is spent. */
  const onChunk = chunk => {
    if (typeof chunk['id'] === 'string' && chunk['id'] !== '') id = chunk['id']
    if (typeof chunk['model'] === 'string' && chunk['model'] !== '') model = chunk['model']
    if (typeof chunk['created'] === 'number') created = chunk['created']

    const choice = Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined
    if (choice === undefined) {
      // A usage-only chunk carries no choices; forward it as-is.
      if (chunk['usage'] !== undefined && chunk['usage'] !== null) write(chunk)
      return false
    }
    const delta = choice['delta']
    const finishReason = choice['finish_reason']

    if (typeof delta === 'object' && delta !== null) {
      if (Array.isArray(delta['tool_calls'])) mergeToolCalls(pending, delta['tool_calls'])
      const carry = {}
      if (typeof delta['content'] === 'string' && delta['content'] !== '') carry['content'] = delta['content']
      if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'] !== '') {
        carry['reasoning_content'] = delta['reasoning_content']
      }
      if (Object.keys(carry).length > 0) {
        const reasoning = carry['reasoning_content']
        const content = carry['content']
        if (reasoning !== undefined) {
          if (contentStarted) {
            // Reasoning trailing the answer: buffer it so the wire never
            // interleaves; it is flushed just before the finish frame.
            lateReasoning += reasoning
            if (content !== undefined) emitContent(content)
          } else {
            // Thinking leads: it takes the top slot. A chunk carrying both
            // fields is split so any held content stays behind the thinking.
            reasoningStarted = true
            emitDelta({ reasoning_content: reasoning })
            flushHeldContent()
            if (content !== undefined) emitContent(content)
          }
        } else if (content !== undefined) {
          if (reasoningStarted) {
            emitContent(content)
          } else if (heldContent === null) {
            // First content delta with the order unknown: hold one chunk. One
            // chunk of latency is the entire cost when no reasoning ever comes.
            heldContent = content
          } else {
            // Second content delta still without reasoning: plain answer stream.
            flushHeldContent()
            emitContent(content)
          }
        }
      }
    }

    // The final chunk normally carries the usage totals; forward them so the
    // client can account for the call.
    if (chunk['usage'] !== undefined && chunk['usage'] !== null) {
      write({ ...chunk, id, model })
    }

    if (typeof finishReason === 'string' && finishReason !== '') {
      // `function_call` is a legacy sibling with no id and no name of its own;
      // when the real tool_calls were already emitted it is redundant.
      emitToolCallsAndFinish(finishReason === 'function_call' && toolCallsSent ? 'tool_calls' : finishReason)
      // Stop reading on the first finish event: everything after it is the
      // upstream repeating itself, and holding the connection open while it
      // does keeps the request alive for no benefit.
      return true
    }
    return false
  }

  return {
    push(text) {
      armIdle()
      let sawEnd = false
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '') continue
        if (payload === '[DONE]') {
          sawEnd = true
          continue
        }
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        if (onChunk(chunk)) sawEnd = true
      }
      return sawEnd
    },
    /** Finish the response: close any dangling tool calls, then terminate. */
    end() {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      if (done) return
      if (pending.size > 0) emitToolCallsAndFinish('tool_calls')
      else if (!settled) {
        // The upstream closed without a finish frame: a cut answer, not a
        // finished one. Reporting `stop` here is what lets a truncated
        // response pass for "the model decided it was done".
        logger?.warn?.('[workbuddy] upstream stream ended without a finish frame — closing as a truncated answer')
        emitToolCallsAndFinish('length')
      } else { flushHeldContent(); flushLateReasoning() }
      done = true
      if (res.writable) res.end('data: [DONE]\n\n')
    },
    /** Stop the heartbeat without ending the response (client went away). */
    dispose() {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      done = true
    },
  }
}
/**
 * Start the endpoint.
 *
 * @param {object} options
 * @param {import('./auth.js').WorkBuddyCredentialStore} options.store
 * @param {import('./catalog.js').WorkBuddyCatalog} options.catalog
 * @param {string} options.token bearer this endpoint requires
 * @param {number} [options.port] fixed port; 0 (default) asks the OS
 * @param {object} [options.logger]
 */
export function createWorkBuddyServer(options) {
  const { token } = options
  const port = options.port ?? 0
  const logger = options.logger ?? console
  const client = options.client ?? new WorkBuddyUpstreamClient()
  /**
   * Variant registry. Each entry: { id, path, prefix, store, catalog }.
   *
   * The two regions share model ids (glm-5.3, hy3, deepseek-v4.1-flash…) but
   * bill against separate accounts, so one id cannot stand for both. The region
   * therefore travels in the URL path rather than in the model id: the root
   * serves the default variant and `/ai/…` the international one, which keeps
   * the ids a client displays clean. `prefix` is the legacy disambiguator, still
   * accepted on a chat request so configurations written before the split keep
   * routing correctly.
   */
  const variants = options.variants ?? [{ id: 'cn', path: '', prefix: '', store: options.store, catalog: options.catalog }]

  let lastCredits = new Map()
  let lastCatalogError = new Map()
  let lastRefreshAtMs = new Map()

  /** The variant a request path is mounted under; the longest mount wins. */
  function variantForPath(pathname) {
    let best
    for (const v of variants) {
      const mount = v.path ?? ''
      if (mount === '') continue
      if (pathname !== mount && !pathname.startsWith(`${mount}/`)) continue
      if (best === undefined || mount.length > (best.path ?? '').length) best = v
    }
    return best
  }

  /** The variant served at the root, which is what a bare `/v1` addresses. */
  function defaultVariant() {
    return variants.find(v => (v.path ?? '') === '') ?? variants[0]
  }

  /**
   * Legacy route: a model id carrying a variant's old `wbai:` prefix names its
   * region outright. Returns undefined when the id carries no known prefix.
   */
  function variantForPrefix(modelId) {
    for (const v of variants) {
      const prefix = v.prefix ?? ''
      if (prefix !== '' && modelId.startsWith(prefix)) {
        return { variant: v, modelId: modelId.slice(prefix.length) }
      }
    }
    return undefined
  }

  /**
   * Pull the live roster for every variant and gate visibility on having a
   * usable credential.
   *
   * The gate is load-bearing: a signed-out account must expose *no* models.
   * Serving the fallback roster to a signed-out user offers models that can
   * only fail, which is worse than showing nothing.
   */
  async function refreshCatalog() {
    const results = []
    for (const variant of variants) {
      const { catalog } = variant
      try {
        const credential = await variant.store.resolve()
        catalog.setVisible(true)
        const models = await client.fetchModels(credential)
        catalog.set(models, { source: client.lastCatalog?.source, fetchedAtMs: client.lastCatalog?.fetchedAtMs })
        lastCatalogError.set(variant.id, undefined)
        lastRefreshAtMs.set(variant.id, Date.now())
        logger.log(`[workbuddy] ${variant.id} catalog refreshed: ${models.length} models (${catalog.source})`)
        try {
          lastCredits.set(variant.id, await client.fetchCredits(credential))
        } catch (error) {
          logger.warn(`[workbuddy] ${variant.id} credit lookup failed: ${String(error)}`)
        }
        results.push({ variant: variant.id, ok: true, count: models.length })
      } catch (error) {
        // No credential: hide the roster rather than advertise unusable models.
        catalog.setVisible(false)
        lastCatalogError.set(variant.id, error instanceof Error ? error.message : String(error))
        logger.warn(`[workbuddy] ${variant.id} catalog unavailable: ${lastCatalogError.get(variant.id)}`)
        results.push({ variant: variant.id, ok: false, error: lastCatalogError.get(variant.id) })
      }
    }
    return { ok: results.some(r => r.ok), results }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) writeOpenAIError(res, 500, 'internal', String(error))
      else res.end()
    })
  })

  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  async function handle(req, res) {
    // Every request must name the loopback host, and browser-sent origins must
    // be loopback too. A DNS-rebinding page satisfies neither.
    if (!hostIsLoopback(req.headers.host)) {
      writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
      return
    }
    const url = (req.url ?? '/').split('?')[0]
    // A variant mount is stripped before routing, so `/ai/v1/chat/completions`
    // reaches the same handler as `/v1/chat/completions` with the AI variant
    // selected. Every route honours a mount, management routes included.
    const scoped = variantForPath(url)
    const stripped = url.slice(scoped === undefined ? 0 : (scoped.path ?? '').length)
    const path = stripped === '' ? '/' : stripped

    // Model discovery and health probes are exempt from the bearer: a client
    // registering this endpoint (ZCode's provider-adding flow probes
    // `/v1/models`, sometimes without credentials) must be able to see the
    // roster, and it carries nothing sensitive — ids, windows, vision flags.
    // Chat stays behind the bearer because it spends the account's quota.
    const publicRead = req.method === 'GET'
      && (path === '/v1/models' || path === '/v1/models/' || path === '/healthz' || path === '/healthz/')
    if (!publicRead && !bearerOk(req, token)) {
      writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
      return
    }

    if (req.method === 'GET' && (path === '/healthz' || path === '/healthz/')) {
      writeJson(res, 200, {
        ok: true,
        models: variants.reduce((sum, v) => sum + v.catalog.current().length, 0),
        variants: variants.map(v => ({ id: v.id, models: v.catalog.current().length, source: v.catalog.source, visible: v.catalog.isVisible() })),
      })
      return
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) {
      // Scoped to the mount: `/ai/v1/models` answers with the international
      // roster under its own clean ids. The aggregate view lives at /healthz
      // and /v1/status, which report every variant.
      const listed = scoped === undefined ? [defaultVariant()] : [scoped]
      // Temporary diagnostic: who is asking, and do they send a bearer?
      logger.info(`[workbuddy] GET ${url} auth=${req.headers.authorization ? 'yes' : 'no'} ua=${(req.headers['user-agent'] ?? '?').slice(0, 80)}`)
      writeJson(res, 200, {
        object: 'list',
        data: listed.flatMap(variant => variant.catalog.current().map(model => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: `workbuddy-${variant.id}`,
          // Non-standard extras: harmless to a strict client, and the only way
          // a caller can learn the real window and vision support before it
          // sends a message the upstream would reject.
          context_window: model.contextWindow,
          max_output_tokens: model.maxTokens,
          supports_images: model.supportsImages,
          display_name: model.name,
        }))),
      })
      return
    }
    if (req.method === 'POST' && (path === '/v1/refresh' || path === '/v1/refresh/')) {
      const result = await refreshCatalog()
      writeJson(res, result.ok ? 200 : 503, result)
      return
    }
    if (req.method === 'GET' && (path === '/v1/status' || path === '/v1/status/')) {
      const statuses = await Promise.all(variants.map(async variant => ({
        variant: variant.id,
        auth: await variant.store.status(),
        credits: lastCredits.get(variant.id),
        catalog: {
          source: variant.catalog.source,
          visible: variant.catalog.isVisible(),
          count: variant.catalog.current().length,
          fetchedAtMs: variant.catalog.fetchedAtMs,
          lastRefreshAtMs: lastRefreshAtMs.get(variant.id),
          error: lastCatalogError.get(variant.id),
        },
      })))
      writeJson(res, 200, { variants: statuses })
      return
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/chat/completions/')) {
      await chatCompletions(req, res, scoped)
      return
    }
    // A 404 here is usually a client probing the wrong path (a provider-adding
    // flow appending /v1 twice, say). Log it so the path can be read off the
    // wire instead of guessed.
    logger.warn(`[workbuddy] 404 ${req.method} ${url} host=${req.headers.host ?? '?'} ua=${(req.headers['user-agent'] ?? '?').slice(0, 80)}`)
    writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  }

  async function chatCompletions(req, res, scoped) {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    // 丢掉「既无正文也无工具调用」的 assistant 消息：留着会让上游之后每一轮都拒绝请求。
    const sanitized = sanitizeHistory(raw)
    if (sanitized.dropped > 0) {
      logger.warn(`[workbuddy] dropped ${sanitized.dropped} empty assistant message(s) from the request history`)
    }
    let wantsStream = true
    let model = 'workbuddy'
    try {
      const parsed = JSON.parse(raw)
      wantsStream = parsed?.['stream'] !== false
      if (typeof parsed?.['model'] === 'string') model = parsed['model']
    } catch {
      // prepareChatBody tolerates a non-JSON body; treat it as asking to stream.
    }

    // The region comes from the mount the request arrived on. A legacy `wbai:`
    // prefix on the id still names it outright and wins, so configurations
    // written before the split keep routing correctly. Rewriting the model
    // field textually (rather than re-serialising the parsed body) keeps every
    // other field byte-identical to what the client sent.
    const legacy = variantForPrefix(model)
    const variant = legacy === undefined ? (scoped ?? defaultVariant()) : legacy.variant
    const upstreamModel = legacy === undefined ? model : legacy.modelId
    const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const routed = upstreamModel === model
      ? sanitized.body
      : sanitized.body.replace(new RegExp(`("model"\\s*:\\s*")${escaped}"`), `$1${upstreamModel}"`)

    let credential
    try {
      credential = await variant.store.resolve()
    } catch (error) {
      writeOpenAIError(res, 401, 'not_signed_in', `${variant.id}: ${String(error)}`)
      return
    }
    const prepared = prepareChatBody(routed)

    const controller = new AbortController()
    // Disconnect detection: on Node >= 16 `req` 'close' fires once the request
    // BODY has been received — never when the client goes away — so a cancel
    // went unnoticed and the upstream kept generating into a dead socket
    // (billable, and it counts against the account's concurrency limit).
    // `res` 'close' is the real socket close; `writableEnded` tells a finished
    // response apart from an abandoned one.
    res.on('close', () => {
      if (res.writableEnded) return
      logger.warn('[workbuddy] client disconnected mid-stream — releasing the upstream turn')
      controller.abort('client disconnected')
    })
    const result = await client.chatStream(credential, prepared, controller.signal)

    if (!result.ok) {
      const kind = KIND_STATUS[result.kind] === undefined ? 'server' : result.kind
      const detail = String(result.message ?? '').trim()
      const message = detail === ''
        ? `workbuddy upstream returned http ${result.status} with an empty body (most often a rejected history: empty assistant message, orphan tool result, or an oversized payload)`
        : `workbuddy upstream ${result.kind} (http ${result.status}): ${detail.slice(0, 400)}`
      diag(`upstream-fail kind=${result.kind} status=${result.status} msg=${detail.slice(0, 120)}`)
      writeOpenAIError(res, KIND_STATUS[kind], result.kind, message)
      return
    }

    if (!wantsStream) {
      // The upstream always streams; reassemble for a client that asked for one
      // JSON answer. Errors are surfaced as a real 502 rather than a 200 with an
      // empty body, because a silent empty completion is indistinguishable from
      // a model that chose to say nothing.
      try {
        const completion = await collectCompletion(result.response.body, model)
        writeJson(res, 200, completion)
      } catch (error) {
        writeOpenAIError(res, 502, 'upstream_stream_failed', String(error))
      }
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const normalizer = createStreamNormalizer(res, model, {
      logger,
      onStall: () => controller.abort('upstream stalled'),
    })
    const decoder = new TextDecoder()
    const reader = result.response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (normalizer.push(decoder.decode(value, { stream: true }))) break
      }
      normalizer.end()
    } catch (error) {
      logger.warn(`[workbuddy] upstream stream failed mid-flight: ${String(error)}`)
      // Always close the SSE stream properly: a client left waiting for a
      // terminator that never arrives hangs the whole conversation.
      normalizer.end()
    } finally {
      normalizer.dispose()
      void result.response.body.cancel?.().catch?.(() => {})
    }
  }

  let refreshTimer

  return {
    ready,
    port: () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('workbuddy server has no listening address')
      return address.port
    },
    baseUrl: () => `http://127.0.0.1:${(() => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('workbuddy server has no listening address')
      return address.port
    })()}`,
    refreshCatalog,
    credits: () => lastCredits,
    client,
    start({ listen = true } = {}) {
      if (listen) server.listen(port, '127.0.0.1')
      void refreshCatalog().then(() => {
        refreshTimer = setInterval(() => void refreshCatalog(), CATALOG_REFRESH_MS)
        refreshTimer.unref?.()
      })
      return ready
    },
    close: () => new Promise((resolve, reject) => {
      if (refreshTimer !== undefined) clearInterval(refreshTimer)
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}