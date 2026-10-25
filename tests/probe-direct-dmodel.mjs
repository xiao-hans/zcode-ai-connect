// probe-direct-dmodel.mjs — raw SSE dump for dmodel via the gateway.
import crypto from 'node:crypto'
const mod = await import('../zcode-qoder-connect/src/credentials.js')
const up = await import('../zcode-qoder-connect/src/upstream.js')
const store = new mod.QoderCredentialStore({ stateDir: 'C:/Users/HANXIAO/.zcode-qoder-connect' })
const cred = await store.resolve()
const requestId = crypto.randomUUID()
const req = {
  request_id: requestId, request_set_id: crypto.randomUUID(), chat_record_id: requestId,
  session_id: crypto.createHash('md5').update('qoder-session:' + cred.userID + ':dmodel').digest('hex') + '-' + crypto.randomUUID(),
  stream: true, chat_task: 'FREE_INPUT', is_reply: true, is_retry: false, source: 1, version: '3',
  session_type: 'qoderclicn', agent_id: 'agent_common', task_id: 'common', code_language: '', chat_prompt: '',
  image_urls: null, aliyun_user_type: '', system: '',
  messages: [{ role: 'user', content: 'hi' }],
  tools: null, parameters: { max_tokens: 50 },
  chat_context: { chatPrompt: '', imageUrls: null, extra: { context: [], modelConfig: { key: 'qfmodel', is_reasoning: false } } },
}
const bodyStr = up.qoderEncodeBody(JSON.stringify(req))
const CHAT_URL = 'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
const r = await fetch(CHAT_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-model-key': 'qfmodel', 'x-model-source': 'system', 'user-agent': 'qoder/1.1.77', ...up.buildCosyHeaders({ body: bodyStr, url: CHAT_URL, credential: cred }) },
  body: bodyStr, signal: AbortSignal.timeout(90000),
})
console.log('HTTP', r.status)
const reader = r.body.getReader(), dec = new TextDecoder()
let shown = 0
try {
  while (shown < 14) {
    const { done, value } = await reader.read()
    if (done) { console.log('(stream ended)'); break }
    const t = dec.decode(value, { stream: true })
    for (const line of t.split('\n')) {
      if (line.startsWith('data:') && shown < 14) { console.log('FRAME:', line.slice(5).trim().slice(0, 280)); shown++ }
    }
  }
} catch (e) { console.log('stream err:', e.message.slice(0, 60)) }
