import fs from 'node:fs'
import { fetchSoloDirectory } from '../zcode-trae-connect/src/llm-utils.js'
const auth = JSON.parse(fs.readFileSync('C:/Users/HANXIAO/.zcode-trae-connect/.trae-credentials.json', 'utf8')).auth
const { byId, failures } = await fetchSoloDirectory({ token: auth.token, userId: auth.userId, baseUrl: 'https://trae-api-cn.mchost.guru/api/remote/v1' })
console.log('failures:', failures)
console.log('models:', byId.size)
for (const [id, e] of byId) console.log(' ', id, '|', e.ownedFunction, '| ctx', e.contextWindow, '| max', e.maxContextWindow, '| maxTokens', e.maxTokens, '|', (e.efforts || []).join(','))
