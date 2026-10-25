/**
 * End-to-end verification of the zcode-trae-connect endpoint.
 *
 * Run against a live endpoint:   node docs/verify-endpoint.mjs
 * Requires the service to be up on :39272 (node bin/cli.mjs serve).
 *
 * Covers the failure modes that mattered during the port: stream
 * termination (a missing [DONE] hangs the client), non-streaming reassembly
 * (the upstream is an async generator; the endpoint must buffer it into one
 * chat.completion), and schema-valid JSON.
 *
 * There is deliberately no tool-call case: the Trae remote-session protocol
 * is a plain-text channel with no function-calling surface, so the endpoint
 * never emits tool_calls and a client that needs them must use another
 * provider.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const stateDir = process.env['ZCODE_TRAE_CONNECT_HOME'] ?? join(homedir(), '.zcode-trae-connect')
const token = JSON.parse(await readFile(join(stateDir, 'endpoint.json'), 'utf8')).token
const BASE = process.env['ZCODE_TRAE_CONNECT_BASE'] ?? 'http://127.0.0.1:39272/v1'
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const MODEL = process.env['ZCODE_TRAE_CONNECT_MODEL'] ?? 'glm-5.3'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  ok ? pass++ : fail++
}

/** POST and consume the SSE stream, reporting the first-byte latency. */
async function stream(body) {
  const t0 = Date.now()
  const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  if (r.status !== 200) {
    const text = await r.text()
    return { status: r.status, error: text.slice(0, 300) }
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let firstByte = null, sawDone = false, sawHeartbeat = false
  let text = '', reasoning = '', finish = null
  let usage = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstByte === null) firstByte = Date.now() - t0
    for (const line of dec.decode(value, { stream: true }).split('\n')) {
      const t = line.trim()
      if (t.startsWith(':') && t.toLowerCase().includes('heartbeat')) { sawHeartbeat = true; continue }
      if (!t.startsWith('data:')) continue
      const p = t.slice(5).trim()
      if (p === '') continue
      if (p === '[DONE]') { sawDone = true; continue }
      let j; try { j = JSON.parse(p) } catch { continue }
      if (j.usage) usage = j.usage
      const ch = j.choices?.[0]
      if (!ch) continue
      if (ch.finish_reason) finish = ch.finish_reason
      const d = ch.delta
      if (!d) continue
      if (typeof d.content === 'string') text += d.content
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content
    }
  }
  return { status: 200, firstByte, total: Date.now() - t0, sawDone, sawHeartbeat, text, reasoning, finish, usage }
}

console.log('=== 1. streaming text ===')
{
  const r = await stream({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] })
  check('HTTP 200', r.status === 200, r.status === 200 ? `firstByte ${r.firstByte}ms, total ${r.total}ms` : r.error)
  check('terminated with [DONE]', r.sawDone === true)
  check('content received', (r.text ?? '').trim().length > 0, JSON.stringify((r.text ?? '').trim().slice(0, 40)))
  check('finish_reason stop', r.finish === 'stop', JSON.stringify(r.finish))
  check('usage reported', r.usage != null, `${r.usage?.total_tokens} tokens`)
}

console.log('\n=== 2. non-streaming ===')
{
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'Reply with exactly: JSONOK' }] }),
  })
  const j = await r.json()
  check('HTTP 200', r.status === 200, r.status === 200 ? '' : JSON.stringify(j).slice(0, 200))
  check('object is chat.completion', j.object === 'chat.completion', j.object)
  check('message content present', typeof j.choices?.[0]?.message?.content === 'string' && j.choices[0].message.content.trim().length > 0,
    JSON.stringify(j.choices?.[0]?.message?.content?.trim()?.slice(0, 30)))
  check('usage reported', j.usage != null, `${j.usage?.total_tokens} tokens`)
}

console.log('\n=== 3. international mount (informational) ===')
{
  // The intl mount only answers when the Trae international edition is signed
  // in and its upstream resolves; a failure here is not a defect of the CN
  // path, so it reports rather than fails the run.
  const intlBase = BASE.replace(/\/v1$/, '/intl/v1')
  const r = await fetch(`${intlBase}/chat/completions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] }),
  })
  const j = await r.json().catch(() => ({}))
  const content = typeof j.choices?.[0]?.message?.content === 'string' ? j.choices[0].message.content.trim() : ''
  console.log(`[${r.status === 200 && content !== '' ? 'PASS' : 'INFO'}] /intl mount — ${r.status === 200 ? `answered (${content.slice(0, 30)})` : JSON.stringify(j).slice(0, 120)}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
