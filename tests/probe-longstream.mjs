// probe-longstream.mjs — long-output streaming probe.
// Measures inter-chunk gaps through the loopback endpoint and reports how the
// stream ends (finish_reason present? [DONE]? socket error?).
//
// usage: node probe-longstream.mjs <port> <model> [promptWords]
import fs from 'node:fs'

const port = Number(process.argv[2] ?? 39272)
const model = process.argv[3] ?? 'deepseek-v4.1-flash'
const words = Number(process.argv[4] ?? 6000)
const ep = JSON.parse(fs.readFileSync(`C:/Users/HANXIAO/.zcode-trae-connect/endpoint.json`, 'utf8'))
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`

const prompt = `请写一个技术手册，主题是"分布式系统的可观测性"，要求正文不少于 ${words} 个汉字，分章节、每章有小结，不要省略、不要用"略"占位，必须连续写完全部内容。`

const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ep.token },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    max_tokens: 32000,
  }),
})
console.log(stamp(), 'HTTP', r.status, r.headers.get('transfer-encoding'), r.headers.get('content-length'))
if (!r.ok) {
  console.log(await r.text())
  process.exit(1)
}

const reader = r.body.getReader()
const dec = new TextDecoder()
let buf = ''
let bytes = 0
let chunks = 0
let content = 0
let reasoning = 0
let last = Date.now()
let finish = null
const gaps = []
let sawDone = false

try {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) { console.log(stamp(), 'BODY END (no error)'); break }
    const now = Date.now()
    const gap = now - last
    last = now
    if (gap > 2000) gaps.push(`${(gap / 1000).toFixed(1)}s @${stamp()}`)
    bytes += value.length
    chunks++
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (!line.startsWith('data:')) continue
      const p = line.slice(5).trim()
      if (p === '[DONE]') { sawDone = true; console.log(stamp(), '[DONE]'); continue }
      let j
      try { j = JSON.parse(p) } catch { continue }
      const c = j.choices?.[0]
      if (c?.delta?.content) content += c.delta.content.length
      if (c?.delta?.reasoning_content) reasoning += c.delta.reasoning_content.length
      if (c?.finish_reason) { finish = c.finish_reason; console.log(stamp(), 'finish_reason =', finish, { content, reasoning }) }
      if (Array.isArray(c?.delta?.tool_calls)) console.log(stamp(), 'tool_calls delta')
    }
  }
} catch (error) {
  console.log(stamp(), 'READ ERROR:', String(error))
}
console.log('---')
console.log('elapsed', stamp(), 'chunks', chunks, 'bytes', bytes, 'content chars', content, 'reasoning chars', reasoning)
console.log('finish_reason', finish, 'sawDone', sawDone)
console.log('gaps>2s:', gaps.length ? gaps.join(', ') : 'none')
