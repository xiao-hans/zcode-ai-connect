// llm-utils.js — messages-based Trae chat channel (llm_utils_chat).
//
// The chat_sessions path spawns a hosted solo-agent runtime: the model lives
// in Trae's cloud sandbox, executes tools itself and never returns tool_calls
// to the caller (verified 2026-10-24: a read request came back as prose with
// "PathNotFound" from the sandbox). `llm_utils_chat` is the raw LLM proxy the
// IDE's agent uses instead: caller's system messages are honored as system
// (CANARY verified), tools pass through and PENDING tool_calls stream back to
// the caller, and there is no per-request agent session.
//
// Protocol (reverse-engineered from dsh-connect-trae lib/index.js + live
// probes on 2026-10-24):
//   chat  POST {REMOTE}/api/agent/v3/llm_utils_chat
//         body: { app_id?, app_version_code:int64, function, model,
//                 config_name, stream:true, messages:[{role, content:
//                 [{type:"text",text}]}], tools:[{function:{parameters:
//                 string}}], reasoning_effort? }
//         SSE: event:output {response, reasoning_content, tool_calls},
//              event:token_usage, event:error {code, message, extra},
//              event:done {finish_reason}
//   dir   POST {REMOTE}/api/ide/v1/get_detail_param
//         body: {function, config_names:null, need_prompt:false,
//                current_config_info:null, poly_prompt:true, mode_type:null,
//                agent_type:null}
//         → {config_info_list:[…]}
//   headers: Authorization / X-Ide-Token / X-Cloudide-Token = Cloud-IDE-JWT,
//         x-uid, x-plugin-channel: icube-ai, x-app-id: 6eefa01c-…,
//         x-machine-id / x-device-id (from the Trae install's
//         telemetry.machineId), x-device-type / x-device-cpu / x-os-version,
//         x-app-version / x-app-version-code, trace ids.
//
// A model is only callable through the directory function that lists it
// (first function to publish a config_name owns it).

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { join } from 'node:path'

const LLM_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
const SOLO_MODELS_PATH = '/api/ide/v1/get_detail_param'
export const DIRECTORY_FUNCTIONS = [
	'solo_work_remote',
	'solo_work_lite',
	'solo_agent_remote',
	'chat_v3',
	'solo_coder',
]
const DEFAULT_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
const VERSION_CODE_FALLBACK = '20260716'

const nonEmpty = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/** The agent/IDE endpoints hang off the HOST root, not under /api/remote/v1:
 * https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat etc. */
function hostOf(baseUrl) {
	return new URL(baseUrl).origin
}

// --- identity ------------------------------------------------------------

let identityCache

/** Best-effort Trae CN identity: machineId from the app's storage.json,
 * appVersion from its product.json. Same values dsh-connect-trae sends. */
export async function resolveLlmIdentity() {
	if (identityCache) return identityCache
	const home = process.env.USERPROFILE ?? ''
	const storagePaths = [
		join(home, 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
		join(home, 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'storage.json'),
	]
	const productPaths = [
		'D:/Trae CN/resources/app/product.json',
		join(home, 'AppData', 'Local', 'Programs', 'Trae CN', 'resources', 'app', 'product.json'),
		'D:/Trae/resources/app/product.json',
	]
	let machineId
	for (const p of storagePaths) {
		try {
			const storage = JSON.parse(await readFile(p, 'utf8'))
			machineId = nonEmpty(storage['telemetry.machineId'])
			if (machineId) break
		} catch {}
	}
	let appVersion
	for (const p of productPaths) {
		try {
			const product = JSON.parse(await readFile(p, 'utf8'))
			appVersion = nonEmpty(product['appVersion'])
			if (appVersion) break
		} catch {}
	}
	if (!machineId) throw new Error('llm-utils: no Trae storage.json machine id found (is Trae CN installed and signed in?)')
	const deviceId = createHash('sha256').update(machineId).digest('hex').slice(0, 32)
	identityCache = { machineId, deviceId, appVersion, versionCode: VERSION_CODE_FALLBACK }
	return identityCache
}

/** Headers per dsh-connect-trae buildTraeHeaders (default chat profile). */
export function llmHeaders(credential, identity, { accept = 'text/event-stream' } = {}) {
	const trace = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
	return {
		Authorization: `Cloud-IDE-JWT ${credential.token}`,
		'X-Ide-Token': credential.token,
		'X-Cloudide-Token': credential.token,
		'x-uid': credential.userId ?? '',
		'x-plugin-channel': 'icube-ai',
		'User-Agent': `Trae/${identity.appVersion ?? 'unknown'}`,
		'x-app-id': DEFAULT_APP_ID,
		'x-machine-id': identity.machineId,
		'x-device-id': identity.deviceId,
		'x-device-type': 'windows',
		'x-device-cpu': os.cpus()[0]?.model.split(' ')[0],
		'x-os-version': `win32 ${os.release()}`,
		'x-ide-version-type': 'stable',
		'x-app-version': identity.appVersion ?? 'unknown',
		'x-ide-version': identity.appVersion ?? 'unknown',
		'x-app-version-code': identity.versionCode,
		'x-ide-version-code': identity.versionCode,
		'x-custom-trace-id': trace,
		'x-flow-traceparent': `04-${trace}-${trace.slice(0, 16)}-01`,
		'request-traffic-type': 'prod',
		'Content-Type': 'application/json',
		Accept: accept,
	}
}

// --- body shaping (prepareSoloBody semantics) ----------------------------

/** OpenAI messages → llm_utils_chat messages. developer becomes system,
 * string content is wrapped, assistant tool_calls are renamed function_call,
 * tool messages must carry tool_call_id. */
export function toLlmMessages(messages) {
	if (!Array.isArray(messages)) throw new Error('llm-utils: messages must be an array')
	return messages.map((raw) => {
		if (typeof raw !== 'object' || raw === null) return raw
		const message = { ...raw }
		if (message.role === 'developer') message.role = 'system'
		if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }]
		if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
			message.function_call = message.tool_calls
			delete message.tool_calls
		}
		if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || message.tool_call_id === '')) {
			throw new Error('llm-utils: tool message requires tool_call_id')
		}
		return message
	})
}

/** OpenAI tools → wire tools (JSON-schema parameters become a string). */
export function toLlmTools(tools) {
	if (!Array.isArray(tools)) return undefined
	return tools.map((raw) => {
		if (typeof raw !== 'object' || raw === null || typeof raw.function !== 'object' || raw.function === null) return raw
		const fn = { ...raw.function }
		if (fn.parameters !== undefined && typeof fn.parameters !== 'string') fn.parameters = JSON.stringify(fn.parameters)
		return { ...raw, function: fn }
	})
}

// --- directory ------------------------------------------------------------

/** Ask every directory function and union their rosters first-wins.
 * Returns { byId: Map(config_name → entry), failures }. Entry:
 * {id, name, contextWindow, maxContextWindow, maxTokens, efforts,
 *  defaultEffort, ownedFunction}. */
export async function fetchSoloDirectory({ token, userId, baseUrl, signal }) {
	const identity = await resolveLlmIdentity()
	const credential = { token, userId }
	const byId = new Map()
	const failures = []
	for (const directoryFunction of DIRECTORY_FUNCTIONS) {
		try {
			const response = await fetch(`${hostOf(baseUrl)}${SOLO_MODELS_PATH}`, {
				method: 'POST',
				headers: llmHeaders(credential, identity, { accept: 'application/json' }),
				body: JSON.stringify({
					function: directoryFunction,
					config_names: null,
					need_prompt: false,
					current_config_info: null,
					poly_prompt: true,
					mode_type: null,
					agent_type: null,
				}),
				signal: signal ?? AbortSignal.timeout(30_000),
			})
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			const document = await response.json()
			const list = Array.isArray(document?.config_info_list) ? document.config_info_list : []
			for (const raw of list) {
				if (typeof raw !== 'object' || raw === null) continue
				const id = typeof raw.config_name === 'string' ? raw.config_name : ''
				if (id === '' || byId.has(id)) continue
				// Agent-internal entries the IDE never shows the user.
				if (raw.is_invisible_to_user === true) continue
				if (/^custom_model_/.test(id) || /subagent/i.test(id) || /^search_agent/.test(id)) continue
				if (/^(summary|title_generation|input_optimization|fast_apply)/.test(id)) continue
				if (/_advisor/.test(id) || /_auto$/.test(id) || /^(sagitta|aquila)$/.test(id)) continue
				const detail = Array.isArray(raw.model_detail_list) && typeof raw.model_detail_list[0] === 'object' && raw.model_detail_list[0] !== null ? raw.model_detail_list[0] : {}
				const ctx = typeof raw.context_window_tokens === 'object' && raw.context_window_tokens !== null ? raw.context_window_tokens : {}
				const dev = Number(ctx.dev) > 0 ? Number(ctx.dev) : undefined
				const max = Number(ctx.max) > 0 ? Number(ctx.max) : undefined
				const display = typeof raw.display_config === 'object' && raw.display_config !== null ? raw.display_config : {}
				const isReasoning = display.model_capability === 'reasoning_model'
				byId.set(id, {
					id,
					name: nonEmpty(display.display_name) ?? id,
					// Total context window (ctx.dev), not prompt_max_tokens — the
					// latter is the prompt-only cap (168000 for a 200000 model).
					contextWindow: dev ?? (Number(detail.prompt_max_tokens) > 0 ? Number(detail.prompt_max_tokens) : undefined),
					maxContextWindow: max !== undefined && max > (dev ?? 0) ? max : undefined,
					maxTokens: Number(detail.max_tokens) > 0 ? Number(detail.max_tokens) : undefined,
					// The directory publishes no reasoning_effort_options; live
					// probes (2026-10-24) confirmed low/medium/high/max are all
					// accepted on reasoning models.
					efforts: isReasoning ? ['low', 'medium', 'high', 'max'] : [],
					defaultEffort: undefined,
					ownedFunction: directoryFunction,
					reasoning: isReasoning,
				})
			}
		} catch (error) {
			failures.push(`${directoryFunction}: ${String(error).slice(0, 80)}`)
		}
	}
	return { byId, failures }
}

// --- chat -----------------------------------------------------------------

/** In-stream llm_utils_chat failures → loopback error taxonomy. */
export function classifyLlmError(failure) {
	const code = failure?.code
	const message = `Trae code ${code ?? '?'}: ${failure?.message ?? 'unknown'}`
	if (code === 1005 || code === 4008 || code === 4222) return { kind: 'hard_credit', status: 402, message }
	if (code === 4011) return { kind: 'soft_rate', status: 429, message }
	if (code === 401 || code === 403) return { kind: 'authentication', status: 401, message }
	if (code === 4001 || code === 4023) return { kind: 'client', status: 400, message: `${message} (模型不在该 function 的名册里)` }
	if (code === 2001) return { kind: 'server', status: 502, message: `${message} (上游目录暂缺,稍后重试)` }
	return { kind: 'server', status: 502, message }
}

/** One chat turn over llm_utils_chat, re-emitted as an OpenAI-shaped SSE
 * stream (choices[].delta.{content, reasoning_content, tool_calls}) so the
 * loopback server's existing normalizer consumes it unchanged. Resolves with
 * { ok: true, response } — response.body is a real ReadableStream — or
 * { ok: false, kind, status, message } when the failure lands before the
 * first output frame. */
export async function llmChatStream({ credential, identity, baseUrl, openaiBody, ownedFunction, signal }) {
	const input = typeof openaiBody === 'string' ? JSON.parse(openaiBody) : openaiBody
	const model = typeof input.model === 'string' && input.model.trim() !== '' ? input.model.trim() : 'glm-5.2'
	const wire = {
		messages: toLlmMessages(input.messages),
		model,
		config_name: model,
		function: ownedFunction ?? 'solo_work_lite',
		stream: true,
		...(Array.isArray(input.tools) ? { tools: toLlmTools(input.tools) } : {}),
		...(typeof input.reasoning_effort === 'string' && input.reasoning_effort !== '' ? { reasoning_effort: input.reasoning_effort } : {}),
	}

	const encoder = new TextEncoder()

	/** Frame reader over the gateway SSE. Resumable: the caller may hand the
	 * generator to a background pump and keep pulling it later. */
	async function* gatewayFrames(response) {
		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		let eventName = ''
		for (;;) {
			const { done, value } = await reader.read()
			if (done) return
			buffer += decoder.decode(value, { stream: true })
			let index
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index).replace(/\r$/, '')
				buffer = buffer.slice(index + 1)
				if (line.startsWith('event:')) {
					eventName = line.slice(6).trim()
					continue
				}
				if (!line.startsWith('data:')) continue
				const raw = line.slice(5).trim()
				if (raw === '' || raw === '[DONE]') return
				let record
				try { record = JSON.parse(raw) } catch { continue }
				yield { eventName, record }
			}
		}
	}

	const deltaChunks = (record) => {
		const chunks = []
		const reasoning = typeof record.reasoning_content === 'string' && record.reasoning_content !== '' ? record.reasoning_content : undefined
		const text = typeof record.response === 'string' && record.response !== '' ? record.response : undefined
		if (reasoning !== undefined) chunks.push({ choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] })
		if (text !== undefined) chunks.push({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
		if (Array.isArray(record.tool_calls)) {
			for (const call of record.tool_calls) {
				const fn = call.function_call ?? call.function ?? {}
				chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: call.index ?? 0, ...(call.id ? { id: call.id } : {}), type: 'function', function: { ...(call.id ? { name: fn.name ?? '' } : {}), arguments: fn.arguments ?? '' } }] }, finish_reason: null }] })
			}
		}
		return chunks
	}

	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 6000))
		let response
		try {
			response = await fetch(`${hostOf(baseUrl)}${LLM_CHAT_PATH}`, {
				method: 'POST',
				headers: llmHeaders(credential, identity),
				body: JSON.stringify(wire),
				signal: signal ?? AbortSignal.timeout(120_000),
			})
		} catch (error) {
			return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
		}
		if (!response.ok) {
			const text = await response.text().catch(() => '')
			if (response.status === 403 && /10605|isQueued/.test(text) && attempt < 3) continue
			const kind = response.status === 401 || response.status === 403 ? 'authentication' : response.status === 429 ? 'soft_rate' : response.status >= 500 ? 'server' : 'client'
			return { ok: false, status: response.status, kind, message: text.slice(0, 400) }
		}

		const frames = gatewayFrames(response)
		for (;;) {
			const next = await frames.next()
			if (next.done) break
			const { eventName, record } = next.value

			// Refusal envelopes (statusCodeValue !== 200) before the first
			// output frame are real failures; a 403/10605 here is the queue
			// answer → retry with a fresh request.
			if (typeof record.statusCodeValue === 'number' && record.statusCodeValue !== 200) {
				const bodyText = String(record.body ?? '')
				if (record.statusCodeValue === 403 && /10605|isQueued/.test(bodyText) && attempt < 3) break
				frames.return?.()
				const kind = record.statusCodeValue === 401 || record.statusCodeValue === 403 ? 'authentication' : 'server'
				return { ok: false, status: 502, kind, message: `upstream ${record.statusCodeValue}: ${bodyText.slice(0, 240)}` }
			}
			const isError = eventName === 'error' ||
				(record.code !== undefined && record.message !== undefined && record.response === undefined && !Array.isArray(record.tool_calls))
			if (isError) {
				frames.return?.()
				return { ok: false, ...classifyLlmError({ code: record.code, message: record.message ?? '', extra: record.extra }) }
			}
			if (eventName === 'done') {
				frames.return?.()
				return { ok: false, status: 502, kind: 'server', message: 'llm_utils_chat ended before any output' }
			}
			if (eventName !== 'output' && record.response === undefined && record.reasoning_content === undefined) continue

			// First output frame: hand the response back NOW and keep pumping
			// the remaining gateway frames from inside the stream's start().
			// Returning only after the upstream finished would deliver reasoning
			// and content in one burst instead of streaming them.
			const firstChunks = deltaChunks(record)
			const stream = new ReadableStream({
				async start(controller) {
					try {
						for (const chunk of firstChunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
						for (;;) {
							const next = await frames.next()
							if (next.done) break
							const { eventName: ev, record: rec } = next.value
							if (typeof rec.statusCodeValue === 'number' && rec.statusCodeValue !== 200) break
							if (ev === 'error') break
							if (ev === 'token_usage') {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: rec.prompt_tokens, completion_tokens: rec.completion_tokens, total_tokens: rec.total_tokens } })}\n\n`))
								continue
							}
							if (ev === 'done') {
								const fr = typeof rec.finish_reason === 'string' && rec.finish_reason !== '' ? rec.finish_reason : 'stop'
								controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: fr }] })}\n\n`))
								controller.enqueue(encoder.encode('data: [DONE]\n\n'))
								break
							}
							for (const chunk of deltaChunks(rec)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
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
			return { ok: true, response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) }
		}
	}
	return { ok: false, status: 429, kind: 'soft_rate', message: 'llm_utils_chat kept queueing (10605) after 4 attempts' }
}
