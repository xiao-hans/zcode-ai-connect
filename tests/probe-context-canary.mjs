// probe-context-canary.mjs — does an oversized prompt lose its HEAD silently?
// Puts a canary at the very start of a large prompt and asks for it at the end.
//   canary echoed  → the whole prompt really was visible (big window, no cutoff)
//   canary missing → the gateway silently truncated the head: system prompt and
//                    early task context disappear on long tasks.
//
// usage: node probe-context-canary.mjs <chars> [model]
import fs from 'node:fs'
import { llmHeaders, resolveLlmIdentity, toLlmMessages } from '../zcode-trae-connect/src/llm-utils.js'

const chars = Number(process.argv[2] ?? 700000)
const model = process.argv[3] ?? 'glm-5.3-flash'
const canary = '紫色犀牛7734'
const auth = JSON.parse(fs.readFileSync('C:/Users/HANXIAO/.zcode-trae-connect/.trae-credentials.json', 'utf8')).auth
const identity = await resolveLlmIdentity()

let filler = `最重要前提：暗号是「${canary}」。稍后会要求你复述。\n`
let n = 0
while (filler.length < chars) filler += `第${++n}行：缓存一致性协议需要处理失效、回写与顺序三类问题。\n`
const prompt = `${filler}\n只回答一个问题：本次对话中提到的暗号是什么？只回复暗号本身。`

const wire = {
  messages: toLlmMessages([{ role: 'user', content: prompt }]),
  model,
  config_name: model,
  function: 'solo_work_remote',
  stream: true,
}
console.log('payload chars', JSON.stringify(wire).length, '≈', Math.round(JSON.stringify(wire).length / 2), 'tokens est')

const t0 = Date.now()
const r = await fetch('https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat', {
  method: 'POST',
  headers: llmHeaders({ token: auth.token, userId: auth.userId }, identity),
  body: JSON.stringify(wire),
})
const dec = new TextDecoder()
let buf = ''
let evName = ''
let content = ''
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
    if (typeof rec.response === 'string') content += rec.response
  }
}
console.log('elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's')
console.log('answer:', JSON.stringify(content.slice(0, 200)))
console.log(content.includes(canary) ? 'RESULT: canary found — full prompt visible' : 'RESULT: canary MISSING — head was truncated')
