// probe-context-limit.mjs — what does the llm_utils_chat gateway do when the
// prompt exceeds the real window? Answers whether an overstated contextWindow
// turns "long task" into a silent stop.
//
// usage: node probe-context-limit.mjs <chars>
import fs from 'node:fs'
import { llmHeaders, resolveLlmIdentity, toLlmMessages } from '../zcode-trae-connect/src/llm-utils.js'

const chars = Number(process.argv[2] ?? 700000)
const auth = JSON.parse(fs.readFileSync('C:/Users/HANXIAO/.zcode-trae-connect/.trae-credentials.json', 'utf8')).auth
const identity = await resolveLlmIdentity()

// Distinct filler so no compression/dedup trick can shrink it.
let filler = ''
let n = 0
while (filler.length < chars) filler += `第${++n}行：缓存一致性协议需要处理失效、回写与顺序三类问题。\n`
const prompt = filler + '\n只回复两个字：收到'

const wire = {
  messages: toLlmMessages([{ role: 'user', content: prompt }]),
  model: 'glm-5.3-flash',
  config_name: 'glm-5.3-flash',
  function: 'solo_work_remote',
  stream: true,
}
console.log('payload chars', JSON.stringify(wire).length, '(≈', Math.round(JSON.stringify(wire).length / 2), 'tokens est)')

const t0 = Date.now()
const r = await fetch('https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat', {
  method: 'POST',
  headers: llmHeaders({ token: auth.token, userId: auth.userId }, identity),
  body: JSON.stringify(wire),
})
console.log('HTTP', r.status)
const dec = new TextDecoder()
let buf = ''
let evName = ''
let content = ''
let events = {}
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
    events[evName || '?'] = (events[evName || '?'] ?? 0) + 1
    if (typeof rec.response === 'string') content += rec.response
    if (evName === 'error') console.log('ERROR:', JSON.stringify(rec).slice(0, 400))
    if (evName === 'done') console.log('DONE:', JSON.stringify(rec).slice(0, 200))
  }
}
console.log('elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'events', JSON.stringify(events))
console.log('content:', JSON.stringify(content.slice(0, 200)))
