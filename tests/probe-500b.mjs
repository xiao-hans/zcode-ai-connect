// probe-500b.mjs — capture the error body again
import fs from 'node:fs'
const ep = JSON.parse(fs.readFileSync('C:/Users/HANXIAO/.zcode-qoder-connect/endpoint.json', 'utf8'))
const r = await fetch('http://127.0.0.1:39270/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ep.token },
  body: JSON.stringify({ model: 'dmodel', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, stream: true }),
})
console.log('HTTP', r.status)
console.log((await r.text()).slice(0, 400))
