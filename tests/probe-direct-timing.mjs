// probe-direct-timing.mjs — gateway-direct timing (bypasses the local server).
import crypto from 'node:crypto'
const mod = await import('../src/credentials.js')
const up = await import('../src/upstream.js')
const store = new mod.QoderCredentialStore({ stateDir: 'C:/Users/HANXIAO/.zcode-qoder-connect' })
const cred = await store.resolve()
const CHAT_URL = 'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
// NOTE: this is the QODER gateway — for timing comparison of TRAE use the trae gateway below.
