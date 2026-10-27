// probe-wb-hy3.mjs — free-model live test on the new account.
import fs from 'node:fs'
const ep = JSON.parse(fs.readFileSync('C:/Users/HANXIAO/.zcode-workbuddy-connect/endpoint.json', 'utf8'))
const r = await fetch('http://127.0.0.1:39271/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ep.token },
  body: JSON.stringify({
    model: 'hy3',
    messages: [{ role: 'user', content: '1+1等于几?只回答数字。' }],
    max_tokens: 200, stream: false,
  }),
})
const j = await r.json()
const msg = j.choices?.[0]?.message || {}
console.log('HTTP', r.status, '|', String(msg.content ?? '').trim().slice(0, 40), '| reasoning长度:', String(msg.reasoning_content ?? '').length)
