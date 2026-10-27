// probe-poison-e2e.mjs — poisoned-history end-to-end verification (one tiny request).
import fs from 'node:fs'
const ep = JSON.parse(fs.readFileSync('C:/Users/HANXIAO/.zcode-trae-connect/endpoint.json', 'utf8'))
const r = await fetch('http://127.0.0.1:39272/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ep.token },
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: '你是编码代理。' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_x', content: '文件内容' },
      { role: 'assistant', content: [] },
      { role: 'user', content: '回复两个字:毒清' },
    ],
    max_tokens: 60, stream: false,
  }),
})
const j = await r.json()
const t = String(j.choices?.[0]?.message?.content ?? '').trim()
console.log('HTTP', r.status, '|', t.startsWith('毒清') ? '✅ 带毒历史通过' : JSON.stringify(t.slice(0, 80)))
