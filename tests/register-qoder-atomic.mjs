// register-qoder-atomic.mjs — register Qoder into ZCode's picker config with the
// same discipline workbuddy's setup uses: ZCode must be CLOSED first (it keeps
// config.json in memory and overwrites it on exit), then atomic temp->rename write.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const home = os.homedir()
const configPath = path.join(home, '.zcode', 'v2', 'config.json')
const QODER_KEY = '4d21d570-09de-47f2-8815-7438a52491e7'
const STALE_KEY = 'q1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c'

// 1) Close ZCode (it would overwrite our write with its in-memory view).
let running = 0
try {
  running = execSync('tasklist', { encoding: 'utf8' }).split('\n').filter(l => /zcode\.exe/i.test(l)).length
} catch {}
if (running > 0) {
  console.log('正在退出 ZCode (' + running + ' 个进程)…')
  try { execSync('taskkill /F /IM ZCode.exe', { stdio: 'ignore' }) } catch {}
} else {
  console.log('ZCode 未运行')
}
await new Promise(r => setTimeout(r, 4000))

// 2) Read the endpoint state
const qEp = JSON.parse(fs.readFileSync(path.join(home, '.zcode-qoder-connect', 'endpoint.json'), 'utf8'))
const qBase = `http://127.0.0.1:${qEp.port || 39270}/v1`
let rows = null
try {
  const r = await fetch(`${qBase}/models`, { headers: { Authorization: `Bearer ${qEp.token}` }, signal: AbortSignal.timeout(15000) })
  rows = (await r.json()).data ?? null
  if (rows) console.log('从端点拉到', rows.length, '个模型')
} catch {
  console.log('端点不可达(服务未运行)— 用内置名册注册')
}
if (!rows || rows.length === 0) {
  // 端点没跑时的兜底名册(id 与 /v1/models 一致,服务起来后即可用)
  rows = [
    { id: 'qoder-fast', display_name: 'Fast' },
    { id: 'qwen3.8-max', display_name: 'Qwen3.8-Max' },
    { id: 'qwen3.8-flash', display_name: 'Qwen3.8-Flash' },
    { id: 'deepseek-v4-pro', display_name: 'DeepSeek-V4-Pro' },
    { id: 'deepseek-flash', display_name: 'DeepSeek-Flash' },
    { id: 'glm-5.3', display_name: 'GLM-5.3' },
    { id: 'glm-5.3-flash', display_name: 'GLM-5.3-Flash' },
    { id: 'kimi-k3.1-pro', display_name: 'Kimi-K3.1-Pro' },
    { id: 'kimi-k2.8-preview', display_name: 'Kimi-K2.8-Preview' },
    { id: 'minimax-m3.1-flash', display_name: 'MiniMax-M3.1-Flash' },
  ].map(r => ({ id: r.id, display_name: r.display_name, context_window: 1000000, max_output_tokens: 32000, supports_images: false }))
}

const models = {}
for (const row of rows) {
  if (row.id === 'qoder-auto') continue
  models[row.id] = {
    name: row.display_name ?? row.id,
    limit: { context: row.context_window ?? 180000, output: row.max_output_tokens ?? 32000 },
    modalities: { input: row.supports_images ? ['text', 'image'] : ['text'], output: ['text'] },
  }
}

// 3) Atomic write (temp + rename), preserving everything else
const document = JSON.parse(fs.readFileSync(configPath, 'utf8'))
document.provider ??= {}
delete document.provider[STALE_KEY]
document.provider[QODER_KEY] = {
  name: 'Qoder',
  kind: 'openai-compatible',
  options: { apiKey: qEp.token, baseURL: qBase, apiKeyRequired: true },
  source: 'custom',
  models,
}
const tempPath = `${configPath}.${process.pid}.tmp`
fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
fs.renameSync(tempPath, configPath)

console.log('已写入 qoder 条目:', QODER_KEY, '| models:', Object.keys(models).length)
console.log('模型:', Object.keys(models).join(', '))
console.log('\n现在请重新启动 ZCode —— 模型选择器里应出现 Qoder 分组。')
