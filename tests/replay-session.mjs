// replay-session.mjs — replay a pi session's tail against a loopback endpoint.
// Used to reproduce the "Error: 400 status code (no body)" the session is stuck on.
//
// usage: node replay-session.mjs <session.jsonl> <port> <model> [takeLast] [--drop-empty]
import fs from 'node:fs'

const [file, port, model, takeArg, ...flags] = process.argv.slice(2)
const take = Number(takeArg ?? 30)
const dropEmpty = flags.includes('--drop-empty')
const ep = JSON.parse(fs.readFileSync(`C:/Users/HANXIAO/.zcode-${port === '39271' ? 'workbuddy' : port === '39270' ? 'qoder' : 'trae'}-connect/endpoint.json`, 'utf8'))

const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l, i) => { try { return { i, ...JSON.parse(l) } } catch { return null } })
  .filter(r => r && r.type === 'message')

const toOpenAi = (m) => {
  const out = { role: m.role }
  if (typeof m.content === 'string') out.content = m.content
  else if (Array.isArray(m.content)) {
    const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('')
    out.content = text
  } else out.content = ''
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    out.tool_calls = m.tool_calls.map(c => ({
      id: c.id, type: 'function',
      function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
    }))
  }
  if (m.role === 'toolResult') {
    out.role = 'tool'
    out.tool_call_id = m.toolCallId ?? m.tool_call_id ?? 'call_0'
    out.content = Array.isArray(m.content) ? m.content.map(b => b.text ?? '').join('') : String(m.content ?? '')
  }
  return out
}

let msgs = recs.slice(-take).map(r => toOpenAi(r.message ?? {}))
const before = msgs.length
if (dropEmpty) {
  msgs = msgs.filter(m => !(m.role === 'assistant' && (m.content ?? '') === '' && !(m.tool_calls?.length)))
}
console.log(`messages: ${before} -> ${msgs.length} (dropEmpty=${dropEmpty})`)
console.log('empty assistant in payload:', msgs.filter(m => m.role === 'assistant' && (m.content ?? '') === '' && !(m.tool_calls?.length)).length)

const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ep.token },
  body: JSON.stringify({ model, messages: msgs, stream: true, max_tokens: 64 }),
  signal: AbortSignal.timeout(120_000),
})
const reader = r.body === null ? null : r.body.getReader()
let text = ''
if (reader !== null) {
  const dec = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
    if (done) break
    text += dec.decode(value, { stream: true })
    if (text.length > 4000) break
  }
}
console.log('HTTP', r.status)
console.log('first bytes:', text.slice(0, 600))
