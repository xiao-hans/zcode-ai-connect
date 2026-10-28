// probe-upstream-wire.mjs — talk to Trae's llm_utils_chat directly, logging the
// raw event sequence. Used to learn (a) whether `max_tokens` on the wire is
// honoured and (b) which terminal frames the gateway really sends.
//
// usage: node probe-upstream-wire.mjs <maxTokens|none> [prompt]
import fs from 'node:fs'
import { llmHeaders, resolveLlmIdentity, toLlmMessages } from '../zcode-trae-connect/src/llm-utils.js'

const mtArg = process.argv[2] ?? 'none'
const prompt = process.argv[3] ?? '写一篇关于缓存的文章，至少 800 字。'
const auth = JSON.parse(fs.readFileSync('C:/Users/HANXIAO/.zcode-trae-connect/.trae-credentials.json', 'utf8')).auth
const identity = await resolveLlmIdentity()

const wire = {
  messages: toLlmMessages([{ role: 'user', content: prompt }]),
  model: 'deepseek-v4.1-flash',
  config_name: 'deepseek-v4.1-flash',
  function: 'solo_agent_remote',
  stream: true,
  ...(mtArg === 'none' ? {} : { max_tokens: Number(mtArg) }),
}

const t0 = Date.now()
const r = await fetch('https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat', {
  method: 'POST',
  headers: llmHeaders({ token: auth.token, userId: auth.userId }, identity),
  body: JSON.stringify(wire),
})
console.log('HTTP', r.status, 'content-type', r.headers.get('content-type'))
const dec = new TextDecoder()
let buf = ''
let evName = ''
let content = ''
let reasoning = 0
let events = {}
let done
for await (const chunk of r.body) {
  buf += dec.decode(chunk, { stream: true })
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, '')
    buf = buf.slice(i + 1)
    if (line.startsWith('event:')) { evName = line.slice(6).trim(); continue }
    if (!line.startsWith('data:')) continue
    const p = line.slice(5).trim()
    if (p === '' || p === '[DONE]') continue
    let rec; try { rec = JSON.parse(p) } catch { continue }
    const key = evName || '(none)'
    events[key] = (events[key] ?? 0) + 1
    if (typeof rec.response === 'string') content += rec.response
    if (typeof rec.reasoning_content === 'string') reasoning += rec.reasoning_content.length
    if (evName === 'done' || rec.finish_reason !== undefined) done = rec
    if (evName === 'error') console.log('ERROR frame:', JSON.stringify(rec).slice(0, 300))
  }
}
console.log('elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's')
console.log('events:', JSON.stringify(events))
console.log('content chars', content.length, 'reasoning chars', reasoning)
console.log('done frame:', JSON.stringify(done).slice(0, 400))
console.log('tail:', JSON.stringify(content.slice(-80)))
