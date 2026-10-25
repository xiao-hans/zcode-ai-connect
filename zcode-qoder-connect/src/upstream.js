// upstream.js — Qoder (CN) model-gateway client for zcode-qoder-connect.
//
// Protocol ported from dsh-qoder-connect v0.2.9 (MIT) + live probing on
// 2026-10-25. Three layers:
//
//   COSY signing — every gateway call carries a per-request envelope:
//     random 16-hex AES-128-CBC key (key=IV) encrypts {uid, security_oauth_
//     token, name, email}; RSA-PKCS1 wraps the AES key; MD5 signs
//     payloadB64 \n cosyKey \n timestamp \n body \n sigPath. Full header set
//     below in buildCosyHeaders.
//
//   WAF body encoding — request bodies pass qoderEncodeBody(): base64 with
//     thirds rearranged, then translated through a custom alphabet.
//
//   Two-layer SSE — chat responses stream `data:` frames holding an outer
//     JSON {statusCodeValue?, body:string}; body carries an inner OpenAI-
//     style chunk (choices[].delta.{content, reasoning_content, tool_calls},
//     usage, finish_reason).
//
// Endpoints (china): gateway https://gateway.qoder.com.cn, openapi
// https://openapi.qoder.com.cn. Chat POST {gateway}/algo/api/v2/service/pro/
// sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&
// Encode=1 ; models GET {gateway}/algo/api/v2/model/list?Encode=1 ; check-in
// {openapi}/sash/api/v1/me/campaigns (+ /{id}/claim) with plain Bearer jt-.
//
// chatStream contract (consumed by server.js): resolves
//   {ok:true, response:{body:ReadableStream-of-OpenAI-SSE}} or
//   {ok:false, kind, status, message}.

import crypto from 'node:crypto'

/** Placeholder roster before the first live fetch — intentionally empty: a
 * signed-out account must expose no models rather than stale guesses. */
export const FALLBACK_MODELS = []

export const QODER_IDE_VERSION = '1.1.77'
const USER_AGENT = `qoder/${QODER_IDE_VERSION}`
const LOGIN_VERSION = 'v2'
const MACHINE_OS = `${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}_${process.platform}`
const MACHINE_TYPE_MAGIC = '5'
const DATA_POLICY = 'disagree'

const GATEWAY_BASE = 'https://gateway.qoder.com.cn'
const OPENAPI_BASE = 'https://openapi.qoder.com.cn'

const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

// --- WAF body encoding ------------------------------------------------------

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const ENCODE_TABLE = (() => {
  const table = new Uint8Array(256)
  for (let i = 0; i < 256; i++) table[i] = i
  for (let i = 0; i < 64; i++) table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i)
  table['='.charCodeAt(0)] = '$'.charCodeAt(0)
  return table
})()

/** Qoder WAF encoding: rearranged base64 thirds through a custom alphabet. */
export function qoderEncodeBody(plaintext) {
  const std = Buffer.from(plaintext).toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  const source = Buffer.from(rearranged, 'latin1')
  const target = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) target[i] = ENCODE_TABLE[source[i] ?? 0] ?? 0
  return target.toString('latin1')
}

// --- COSY headers ------------------------------------------------------------

function computeSigPath(urlStr) {
  let sigPath = new URL(urlStr).pathname
  if (sigPath.startsWith('/algo')) sigPath = sigPath.substring(5)
  return sigPath
}

/** COSY-signed headers for one gateway request. `body` is the ENCODED wire
 * body string ('' for GET) — it feeds both the MD5 signature and the
 * body-hash headers, so it must be byte-identical to what is sent. */
export function buildCosyHeaders({ body, url, credential }) {
  const aesKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const userInfo = {
    uid: credential.userID,
    security_oauth_token: credential.authToken,
    name: credential.name ?? '',
    aid: '',
    email: credential.email ?? '',
  }
  const key = Buffer.from(aesKey)
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key)
  const infoB64 = cipher.update(JSON.stringify(userInfo), 'utf8', 'base64') + cipher.final('base64')
  const cosyKey = crypto.publicEncrypt(
    { key: RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey),
  ).toString('base64')
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const payloadB64 = Buffer.from(JSON.stringify({
    version: 'v1',
    requestId: crypto.randomUUID(),
    info: infoB64,
    cosyVersion: QODER_IDE_VERSION,
    ideVersion: '',
  })).toString('base64')
  const sigPath = computeSigPath(url)
  const sig = crypto.createHash('md5')
    .update(`${payloadB64}\n${cosyKey}\n${timestamp}\n${body ?? ''}\n${sigPath}`)
    .digest('hex')
  const bodyHash = crypto.createHash('md5').update(body ?? '').digest('hex')
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': credential.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': QODER_IDE_VERSION,
    'Cosy-Machineid': credential.machineID,
    'Cosy-Machinetoken': credential.machineID,
    'Cosy-Machinetype': MACHINE_TYPE_MAGIC,
    'Cosy-Machineos': MACHINE_OS,
    'Cosy-Clienttype': '5',
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': body ? Buffer.byteLength(body).toString() : '0',
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': LOGIN_VERSION,
    'X-Request-Id': crypto.randomUUID(),
  }
}

// --- error taxonomy ----------------------------------------------------------

function classifyStatus(status, text) {
  if (status === 401 || status === 403) return { kind: 'authentication', status: 401 }
  if (status === 429) return { kind: 'soft_rate', status: 429 }
  if (status === 402) return { kind: 'hard_credit', status: 402 }
  return { kind: status >= 500 ? 'server' : 'client', status: status >= 500 ? 502 : status }
}

function safeJsonParse(text) {
  try { return JSON.parse(text) } catch { return { type: 'object', properties: {} } }
}

// --- client ------------------------------------------------------------------

export class QoderUpstreamClient {
  constructor({ logger = console } = {}) {
    this.logger = logger
    this.lastCatalog = { source: 'fallback', fetchedAtMs: undefined }
  }

  urls() {
    return {
      models: `${GATEWAY_BASE}/algo/api/v2/model/list?Encode=1`,
      chat: `${GATEWAY_BASE}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
      campaigns: `${OPENAPI_BASE}/sash/api/v1/me/campaigns`,
      usage: `${OPENAPI_BASE}/api/v2/quota/usage`,
    }
  }

  /** Live roster from the gateway directory. */
  async fetchModels(credential) {
    const url = this.urls().models
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent': USER_AGENT,
        ...buildCosyHeaders({ body: '', url, credential }),
      },
      signal: AbortSignal.timeout(25000),
    })
    const text = await response.text()
    if (!response.ok) throw Object.assign(new Error(`qoder models [${response.status}]: ${text.slice(0, 200)}`), classifyStatus(response.status, text))
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error('qoder models: 非 JSON 响应') }
    const rows = Array.isArray(payload?.assistant) ? payload.assistant : []
    const models = []
    for (const raw of rows) {
      if (raw?.enable !== true) continue
      const id = typeof raw.key === 'string' ? raw.key.trim() : ''
      if (!id || models.some(m => m.id === id)) continue
      const contextOptions = {}
      if (raw.context_config && typeof raw.context_config === 'object') {
        for (const [key, value] of Object.entries(raw.context_config)) {
          if (value && typeof value === 'object' && typeof value.token_count === 'number' && value.token_count > 0) {
            contextOptions[key] = { tokenCount: value.token_count, isDefault: value.is_default === true }
          }
        }
      }
      const defaults = Object.values(contextOptions).filter(o => o.isDefault)
      const contextWindow = (defaults.length === 1 ? defaults[0].tokenCount : undefined)
        ?? (raw.max_input_tokens > 0 ? raw.max_input_tokens : undefined) ?? 180_000
      const maxAll = Math.max(raw.max_input_tokens > 0 ? raw.max_input_tokens : 0, contextWindow,
        ...Object.values(contextOptions).map(o => o.tokenCount))
      const efforts = Object.keys(raw.thinking_config?.enabled?.efforts ?? {}).filter(e => e.trim())
      models.push({
        id,
        name: typeof raw.display_name === 'string' && raw.display_name.trim() ? raw.display_name.trim() : id,
        contextWindow: maxAll > contextWindow ? maxAll : contextWindow,
        ...(raw.max_output_tokens > 0 ? { maxTokens: raw.max_output_tokens } : {}),
        reasoning: { supports: raw.is_reasoning === true || efforts.length > 0, supportedEfforts: efforts },
        supportsImages: raw.is_vl === true,
        ...(typeof raw.price_factor === 'number' && raw.price_factor >= 0 ? { priceFactor: raw.price_factor } : {}),
      })
    }
    this.lastCatalog = { source: 'qoder-directory', fetchedAtMs: Date.now() }
    return models
  }

  /** Remaining credits (plain Bearer on openapi). */
  async fetchCredits(credential) {
    const response = await fetch(this.urls().usage, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', Authorization: `Bearer ${credential.authToken}` },
      body: '{}',
      signal: AbortSignal.timeout(20000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`qoder usage [${response.status}]: ${text.slice(0, 160)}`)
    const payload = JSON.parse(text)
    return payload?.data?.userQuota ?? payload?.data ?? payload ?? {}
  }

  /** Daily check-in (+100 credits). */
  async checkin(credential) {
    const headers = { accept: 'application/json', Authorization: `Bearer ${credential.authToken}` }
    const listR = await fetch(this.urls().campaigns, { headers, signal: AbortSignal.timeout(20000) })
    const listT = await listR.text()
    if (!listR.ok) throw new Error(`qoder campaigns [${listR.status}]: ${listT.slice(0, 160)}`)
    let campaigns = []
    try { campaigns = JSON.parse(listT).data?.campaigns ?? [] } catch {}
    const benefit = campaigns.find(c => c.actionType === 'CLAIM_BENEFIT')
    if (!benefit) return { status: 'no-campaign', message: '该区域当前没有可领取的签到活动' }
    if (benefit.claimStatus === 'CLAIMED') return { status: 'already-claimed', amount: benefit.benefit?.amount ?? 100 }
    const claimR = await fetch(`${this.urls().campaigns}/${encodeURIComponent(benefit.campaignId)}/claim`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(20000),
    })
    const claimT = await claimR.text()
    if (!claimR.ok) throw new Error(`qoder claim [${claimR.status}]: ${claimT.slice(0, 160)}`)
    let claim = {}
    try { claim = JSON.parse(claimT).data ?? {} } catch {}
    if (claim.status === 'CLAIMED') {
      const amount = claim.benefit?.amount ?? benefit.benefit?.amount ?? 100
      return { status: claim.replayed ? 'already-claimed' : 'claimed', amount }
    }
    return { status: 'failed', message: claimT.slice(0, 200) }
  }

  /**
   * One chat turn. `prepared` is the caller's raw OpenAI request body (JSON
   * string). Resolves {ok:true, response:{body}} where body is a ReadableStream
   * of OpenAI-shaped SSE, or {ok:false, kind, status, message} when the
   * failure lands before the first output frame.
   */
  async chatStream(credential, prepared, signal) {
    let input
    try { input = JSON.parse(prepared) } catch {
      return { ok: false, kind: 'client', status: 400, message: 'invalid JSON body' }
    }
    const modelKey = typeof input.model === 'string' && input.model !== '' ? input.model : 'cmodel'
    const stablePart = crypto.createHash('md5').update(`qoder-session:${credential.userID}:${modelKey}`).digest('hex')
    // Wire shapes (verified against dsh-qoder-connect's translator):
    //   system/user content is a STRING; assistant carries OpenAI-nested
    //   tool_calls + string content; tool rows are flat {role, tool_call_id,
    //   content}; tools themselves are FLAT {type, name, description,
    //   parameters-object} — NOT the OpenAI nested function shape.
    const textOf = (content) => {
      if (typeof content === 'string') return content
      if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('')
      return ''
    }
    let lastUserText = ''
    const wireMessages = (Array.isArray(input.messages) ? input.messages : []).map((raw) => {
      const role = raw?.role === 'developer' ? 'system' : (raw?.role ?? 'user')
      if (role === 'assistant') {
        return {
          role: 'assistant',
          content: textOf(raw.content) || ' ',
          ...(Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0
            ? { tool_calls: raw.tool_calls.map(call => ({ id: String(call.id ?? ''), type: 'function', function: { name: call.function?.name ?? '', arguments: call.function?.arguments ?? '' } })) }
            : {}),
        }
      }
      if (role === 'tool') {
        return { role: 'tool', tool_call_id: String(raw.tool_call_id ?? ''), content: textOf(raw.content) }
      }
      return { role, content: textOf(raw.content) }
    })
    for (let i = wireMessages.length - 1; i >= 0; i--) {
      if (wireMessages[i]?.role === 'user') { lastUserText = String(wireMessages[i].content ?? ''); break }
    }
    // Wire tools keep the OpenAI NESTED shape ({type, function:{name,
    // description, parameters-object}}) — the upstream model API demands
    // tools.0.function as an object ("'function' is a required property",
    // live-verified 2026-10-25); dsh's flat translator feeds an internal
    // shape, not this wire.
    const tools = Array.isArray(input.tools) ? input.tools.map((raw) => ({
      type: 'function',
      function: {
        name: raw?.function?.name ?? raw?.name ?? '',
        description: raw?.function?.description ?? raw?.description ?? '',
        parameters: typeof raw?.function?.parameters === 'string' ? safeJsonParse(raw.function.parameters) : (raw?.function?.parameters ?? raw?.parameters ?? { type: 'object', properties: {} }),
      },
    })) : null
    const buildBody = () => {
      const requestId = crypto.randomUUID()
      const requestSetId = crypto.randomUUID()
      const maxTokens = input.max_tokens > 0 ? input.max_tokens : undefined
      const isReasoning = input.reasoning_effort !== undefined
      return qoderEncodeBody(JSON.stringify({
        request_id: requestId,
        request_set_id: requestSetId,
        chat_record_id: requestId,
        session_id: `${stablePart}-${crypto.randomUUID()}`,
        stream: true,
        chat_task: 'FREE_INPUT',
        is_reply: true,
        is_retry: false,
        source: 1,
        version: '3',
        session_type: 'qoderclicn',
        agent_id: 'agent_common',
        task_id: 'common',
        code_language: '',
        chat_prompt: '',
        image_urls: null,
        aliyun_user_type: '',
        system: '',
        messages: wireMessages,
        tools,
        parameters: {
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          ...(typeof input.reasoning_effort === 'string' && input.reasoning_effort !== '' ? { reasoning_effort: input.reasoning_effort } : {}),
        },
        chat_context: {
          chatPrompt: '',
          imageUrls: null,
          extra: {
            context: [],
            modelConfig: { key: modelKey, is_reasoning: isReasoning },
            originalContent: lastUserText,
            features: [],
          },
          text: lastUserText,
        },
        model_config: {
          key: modelKey,
          is_reasoning: isReasoning,
          ...(maxTokens === undefined ? {} : { max_output_tokens: maxTokens }),
          source: 'system',
        },
        business: {
          product: 'cli',
          version: '1.0.0',
          type: 'agent',
          stage: 'start',
          id: requestSetId,
          name: lastUserText.slice(0, 30),
          begin_at: Date.now(),
        },
      }))
    }
    const chatUrl = this.urls().chat
    // 10605 = "model request is queued": free-tier models answer HTTP 200
    // whose FIRST SSE frame is a 403/queue envelope, or a plain HTTP 403.
    // Either shape retries with a fresh request id (dsh rides a queue-status
    // poll; a timed retry is the pragmatic equivalent).
    const isQueueBody = (text) => /10605|isQueued|queueCount/.test(String(text))
    const encoder = new TextEncoder()
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 6000))
      const encoded = buildBody()
      let response
      try {
        response = await fetch(chatUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'cache-control': 'no-cache',
            'accept-encoding': 'identity',
            'x-model-key': modelKey,
            'x-model-source': 'system',
            'user-agent': USER_AGENT,
            ...buildCosyHeaders({ body: encoded, url: chatUrl, credential }),
          },
          body: encoded,
          signal: signal ?? AbortSignal.timeout(300_000),
        })
      } catch (error) {
        return { ok: false, kind: 'server', status: 0, message: `transport error: ${String(error).slice(0, 160)}` }
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        if (isQueueBody(text) && attempt < 3) continue
        return { ok: false, ...classifyStatus(response.status, text), message: `qoder chat [${response.status}]: ${text.slice(0, 300)}` }
      }

      // Two-layer SSE: data frames hold outer {statusCodeValue?, body:string};
      // body carries the inner OpenAI chunk (choices[].delta.{content,
      // reasoning_content, tool_calls}, usage). The 10605 queue envelope is a
      // REPLAY signal: the gateway closes the SSE for a queued request and
      // the client must wait and replay (dsh rides its queue-status poll; a
      // timed replay is the pragmatic equivalent). The first real output
      // chunk hands the response to the caller immediately, and the rest is
      // pumped from inside the stream.
      const encoder = new TextEncoder()
      const emitFrom = (controller, inner) => {
        const choice = Array.isArray(inner.choices) ? inner.choices[0] : undefined
        if (!choice) return null
        const delta = choice.delta ?? {}
        const carry = {}
        if (typeof delta.content === 'string' && delta.content !== '') carry.content = delta.content
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') carry.reasoning_content = delta.reasoning_content
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          carry.tool_calls = delta.tool_calls.map((call, i) => ({
            index: call.index ?? i,
            ...(call.id ? { id: call.id } : {}),
            type: 'function',
            function: { ...(call.id ? { name: call.function?.name ?? '' } : {}), arguments: call.function?.arguments ?? '' },
          }))
        }
        const finish = typeof choice.finish_reason === 'string' && choice.finish_reason !== '' ? choice.finish_reason : null
        if (Object.keys(carry).length > 0 || finish) {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: carry, finish_reason: finish }] }) + '\n\n'))
        }
        return finish
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 6000))
        const encoded = buildBody()
        let response
        try {
          response = await fetch(chatUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              'cache-control': 'no-cache',
              'accept-encoding': 'identity',
              'x-model-key': modelKey,
              'x-model-source': 'system',
              'user-agent': USER_AGENT,
              ...buildCosyHeaders({ body: encoded, url: chatUrl, credential }),
            },
            body: encoded,
            signal: signal ?? AbortSignal.timeout(300_000),
          })
        } catch (error) {
          return { ok: false, kind: 'server', status: 0, message: `transport error: ${String(error).slice(0, 160)}` }
        }
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          if (isQueueBody(text) && attempt < 3) continue
          return { ok: false, ...classifyStatus(response.status, text), message: `qoder chat [${response.status}]: ${text.slice(0, 300)}` }
        }

        async function* iterateFrames() {
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            let index
            while ((index = buffer.indexOf('\n')) >= 0) {
              let line = buffer.substring(0, index)
              buffer = buffer.substring(index + 1)
              if (line.endsWith('\r')) line = line.slice(0, -1)
              line = line.trim()
              if (!line.startsWith('data:')) continue
              const rawData = line.substring(5).trim()
              if (!rawData) continue
              if (rawData === '[DONE]') return
              let outer
              try { outer = JSON.parse(rawData) } catch { continue }
              if (typeof outer.statusCodeValue === 'number' && outer.statusCodeValue !== 200) {
                yield { kind: 'status', statusCodeValue: outer.statusCodeValue, bodyText: String(outer.body ?? '') }
                continue
              }
              const bodyText = typeof outer.body === 'string' ? outer.body.trim() : ''
              if (!bodyText) continue
              if (bodyText === '[DONE]') return
              let inner
              try { inner = JSON.parse(bodyText) } catch { continue }
              yield { kind: 'chunk', chunk: inner }
            }
          }
        }
        const frames = iterateFrames()
        let firstChunk = null
        for (;;) {
          const next = await frames.next()
          if (next.done) break
          const frame = next.value
          if (frame.kind === 'status') {
            if (frame.statusCodeValue !== 200) {
              if (isQueueBody(frame.bodyText) && attempt < 3) break
              frames.return?.()
              return { ok: false, status: 502, kind: 'server', message: `qoder upstream ${frame.statusCodeValue}: ${frame.bodyText.slice(0, 200)}` }
            }
            continue
          }
          firstChunk = frame.chunk
          break
        }
        if (!firstChunk) continue

        const stream = new ReadableStream({
          async start(controller) {
            try {
              emitFrom(controller, firstChunk)
              for (;;) {
                const next = await frames.next()
                if (next.done) break
                const frame = next.value
                if (frame.kind === 'status' && frame.statusCodeValue !== 200) break
                if (frame.kind !== 'chunk') continue
                emitFrom(controller, frame.chunk)
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            } catch (error) {
              controller.error(error)
            }
          },
          cancel() {
            try { frames.return() } catch {}
          },
        })
        return { ok: true, response: { body: stream } }
      }
      return { ok: false, kind: 'soft_rate', status: 429, message: 'qoder kept queueing (10605) after 4 attempts' }
  }
}
}
