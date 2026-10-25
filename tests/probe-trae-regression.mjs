// probe-trae-regression.mjs — CANARY + tool_calls regression through /v1.
import fs from 'node:fs'
const ep = JSON.parse(fs.readFileSync('C:/Users/HANXIAO/.zcode-trae-connect/endpoint.json', 'utf8'))
const H = { 'content-type': 'application/json', Authorization: 'Bearer ' + ep.token }
async function canary() {
  const r = await fetch('http://127.0.0.1:39272/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'Reply with exactly one line: CANARY-OK. No other words.' },
      { role: 'user', content: '这段代码有问题吗:function f(){ return 1 }' },
    ], max_tokens: 250, stream: false }) })
  const j = await r.json()
  const t = String(j.choices?.[0]?.message?.content || '').trim()
  return t.startsWith('CANARY-OK') ? '✅ PASS' : '❌ ' + JSON.stringify(t.slice(0, 60))
}
async function tools() {
  const r = await fetch('http://127.0.0.1:39272/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: '你是编码代理。读取文件必须调用 read_file 工具。' },
      { role: 'user', content: '读取 C:/Users/HANXIAO/Documents/notes.txt。' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: '读取用户机器上的文件', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } }],
    tool_choice: 'auto', max_tokens: 400, stream: false }) })
  const j = await r.json()
  const msg = j.choices?.[0]?.message || {}
  return msg.tool_calls?.length ? '✅ ' + JSON.stringify(msg.tool_calls[0].function) : '❌ ' + String(msg.content || '').slice(0, 80)
}
console.log('CANARY:', await canary())
console.log('工具调用:', await tools())
