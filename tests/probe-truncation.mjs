// probe-truncation.mjs — is the answer cut off by an upstream output cap?
// Sends the SAME long-output prompt N times and reports content length, finish
// reason, and the tail of the answer. A fixed ceiling across runs (with a
// mid-sentence tail) means the upstream is capping output, not the model
// choosing to stop.
//
// usage: node probe-truncation.mjs <port> <model> <tag> [runs]
import fs from 'node:fs'

const port = Number(process.argv[2])
const model = process.argv[3]
const tag = process.argv[4] ?? 'x'
const runs = Number(process.argv[5] ?? 2)
const epFile = port === 39271 ? 'zcode-workbuddy-connect'
  : port === 39270 ? 'zcode-qoder-connect'
    : 'zcode-trae-connect'
const ep = JSON.parse(fs.readFileSync(`C:/Users/HANXIAO/.${epFile}/endpoint.json`, 'utf8'))

const prompt = '逐条列出 Linux 内核 6.x 中从进程创建到调度落地的完整代码路径，每条给出文件路径与函数名，并附一句话说明。要求至少 400 条，不要省略、不要写“以下省略”。'

for (let run = 1; run <= runs; run++) {
  const t0 = Date.now()
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
  if (!r.ok) { console.log(`run${run} HTTP ${r.status}`, (await r.text()).slice(0, 300)); continue }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = '', content = '', reasoning = '', finish = null, done = false
  for (;;) {
    const { done: d, value } = await reader.read()
    if (d) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (!line.startsWith('data:')) continue
      const p = line.slice(5).trim()
      if (p === '[DONE]') { done = true; continue }
      let j; try { j = JSON.parse(p) } catch { continue }
      const c = j.choices?.[0]
      if (c?.delta?.content) content += c.delta.content
      if (c?.delta?.reasoning_content) reasoning += c.delta.reasoning_content
      if (c?.finish_reason) finish = c.finish_reason
    }
  }
  fs.writeFileSync(`D:/HANXIAO/tools/zcode-ai-connect/tests/out-${tag}-${run}.txt`, content)
  console.log(`run${run} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s chars=${content.length} reasoning=${reasoning.length} finish=${finish} done=${done}`)
  console.log(`  tail: ...${JSON.stringify(content.slice(-90))}`)
}
