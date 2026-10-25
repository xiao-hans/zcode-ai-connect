// probe-trae-direct-timing.mjs — timing against the TRAE gateway directly
// (bypasses the local server), reusing the proven llmHeaders builder.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const suiteRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { llmHeaders, resolveLlmIdentity } = await import(
  new URL('../zcode-trae-connect/src/llm-utils.js', import.meta.url).href)
const cred = JSON.parse(fs.readFileSync(os.homedir() + '/.zcode-trae-connect/.trae-credentials.json', 'utf8')).auth
const identity = await resolveLlmIdentity()
const CHAT_URL = 'https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat'

async function timing(model, fn) {
  const t0 = Date.now()
  const r = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      ...llmHeaders({ token: cred.token, userId: cred.userId }, identity),
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: [{ type: 'text', text: '你是编码代理。' }] },
        { role: 'user', content: [{ type: 'text', text: '用思考推理:一个数组去重有哪几种方法?各有什么优劣?' }] },
      ],
      model, config_name: model, function: fn, stream: true,
    }),
    signal: AbortSignal.timeout(150000),
  })
  if (!r.ok) { console.log(model + '/' + fn, '-> HTTP', r.status, (await r.text()).slice(0, 120)); return }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = '', ev = '', rc = 0, cc = 0
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
        if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue }
        if (!line.startsWith('data:')) continue
        let d; try { d = JSON.parse(line.slice(5).trim()) } catch { continue }
        if (ev === 'output') {
          if (typeof d.reasoning_content === 'string' && d.reasoning_content) { rc += d.reasoning_content.length; log('REASONING', d.reasoning_content.length) }
          if (typeof d.response === 'string' && d.response) { cc += d.response.length; log('CONTENT', d.response.length) }
        }
        if (ev === 'done') { try { await reader.cancel() } catch {} }
      }
    }
  } catch {}
  console.log(model + '/' + fn + ' — reasoning ' + rc + ' chars, content ' + cc + ' chars')
  for (const e of events.slice(0, 20)) console.log('  ' + e.type.padEnd(10), e.start + '-' + e.end + 'ms', 'cum=' + e.total)
  if (events.length > 20) console.log('  … 共', events.length, '段')
}

await timing('deepseek-v4.1-flash', 'solo_work_remote')
await timing('glm-5.2', 'solo_work_lite')
