// probe-reasoning-timing.mjs — delta arrival timing through the trae /v1 path.
import fs from 'node:fs'
const ep = JSON.parse(fs.readFileSync('C:/Users/HANXIAO/.zcode-trae-connect/endpoint.json', 'utf8'))
const t0 = Date.now()
const r = await fetch('http://127.0.0.1:' + ep.port + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ep.token },
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: '你是编码代理。' },
      { role: 'user', content: '用思考推理:一个数组去重有哪几种方法?各有什么优劣?' },
    ],
    max_tokens: 900, stream: true,
  }),
})
console.log('HTTP', r.status)
const reader = r.body.getReader()
const dec = new TextDecoder()
let buf = '', rc = 0, cc = 0
const events = []
const log = (type, len) => {
  const t = Date.now() - t0
  const last = events[events.length - 1]
  if (last && last.type === type) { last.total += len; last.end = t; return }
  events.push({ type, start: t, end: t, total: len })
}
try {
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (!line.startsWith('data:')) continue
      const p = line.slice(5).trim()
      if (p === '[DONE]') continue
      try {
        const j = JSON.parse(p)
        const d = j.choices?.[0]?.delta || {}
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) { rc += d.reasoning_content.length; log('REASONING', d.reasoning_content.length) }
        if (typeof d.content === 'string' && d.content) { cc += d.content.length; log('CONTENT', d.content.length) }
      } catch {}
    }
  }
} catch (e) { console.log('stream end:', e.message.slice(0, 60)) }
console.log('reasoning总长:', rc, '| content总长:', cc)
console.log('到达序列(类型 起始ms-结束ms 累计字符):')
for (const e of events.slice(0, 30)) console.log('  ' + e.type.padEnd(10), e.start + '-' + e.end + 'ms', 'cum=' + e.total)
if (events.length > 30) console.log('  … 共', events.length, '段')
