// register-qwenwork.mjs — register the QwenWork (千问办公) provider into ZCode.
//
// Writes BOTH registration layers:
//   1. provider_config.json — the RULES layer the model dropdown reads
//   2. config.json          — the REGISTRY layer holding the model roster
//
// Both paths are resolved through ZCode's dataBaseDir (%USERPROFILE%\.zcode\v2\
// setting.json → dataBaseDir), which is where the real v2 config lives when a
// redirect is configured; the plain %USERPROFILE%\.zcode\v2 is the fallback.
//
// Run with ZCode CLOSED (tray-exit first): the app keeps config.json in memory
// and rewrites it on exit, which would revert these writes. `--force` writes
// anyway (used when the app demonstrably preserves external edits).
//
// Re-runnable: previous qwenwork entries are replaced, everything else is
// preserved byte-for-byte via atomic temp+rename.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const home = os.homedir()
const FORCE = process.argv.includes('--force')

// --- resolve the real v2 directory ------------------------------------------
function resolveV2Dir() {
  const plain = path.join(home, '.zcode', 'v2')
  try {
    const setting = JSON.parse(fs.readFileSync(path.join(plain, 'setting.json'), 'utf8'))
    if (typeof setting?.dataBaseDir === 'string' && setting.dataBaseDir !== '') {
      return path.join(setting.dataBaseDir, '.zcode', 'v2')
    }
  } catch {}
  return plain
}

const V2 = resolveV2Dir()
const rulesPath = path.join(V2, 'provider_config.json')
const configPath = path.join(V2, 'config.json')
console.log('v2 dir:', V2)

// --- ZCode running check ------------------------------------------------------
let zcodePids = []
try {
  zcodePids = execSync('tasklist', { encoding: 'utf8' })
    .split('\n')
    .filter(l => /zcode\.exe/i.test(l))
} catch {}
if (zcodePids.length > 0 && !FORCE) {
  console.error(`ZCode 正在运行(${zcodePids.length} 个进程)——先托盘退出再运行本脚本,或加 --force。`)
  process.exit(1)
}
if (zcodePids.length > 0) console.warn(`⚠️ ZCode 正在运行(--force 继续写入;若退出时被回滚,请托盘退出后重跑)`)

// --- endpoint + roster --------------------------------------------------------
const epPath = path.join(home, '.zcode-qwenwork-connect', 'endpoint.json')
let ep = { port: 39269, token: '' }
try {
  ep = { ...ep, ...JSON.parse(fs.readFileSync(epPath, 'utf8')) }
} catch {}
const base = `http://127.0.0.1:${ep.port || 39269}`
const bearer = ep.token

const FALLBACK = [
  { id: 'pro', display_name: '高级', context_window: 1000000, max_output_tokens: 32000, supports_images: true },
  { id: 'qwen3.8-flash', display_name: '标准｜Qwen3.8-Flash', context_window: 1000000, max_output_tokens: 32000, supports_images: true },
  { id: 'qwen3.8-max-preview', display_name: 'Qwen3.8-Max', context_window: 1000000, max_output_tokens: 32000, supports_images: true },
]
let rows = null
try {
  const r = await fetch(`${base}/v1/models`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    signal: AbortSignal.timeout(8000),
  })
  if (r.ok) rows = (await r.json()).data ?? null
} catch {}
if (!rows || rows.length === 0) {
  console.log('端点不可达 — 用内置名册注册(服务起来后即可用)')
  rows = FALLBACK
}
const MODEL_IDS = rows.map(r => r.id)
console.log('roster:', MODEL_IDS.join(', '))

// --- 1. rules layer -----------------------------------------------------------
const rulesDoc = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
const providerRules = rulesDoc.config.providerConfigRules.providerRules
const filtered = providerRules.filter(r => r.providerId !== 'qwenwork')
const wb = providerRules.find(r => r.providerId === 'workbuddy') ?? {}
const access = bearer
  ? { type: 'api-key', apiKey: bearer }
  : (wb.config?.access ?? { type: 'api-key', apiKey: '' })
filtered.push({
  providerId: 'qwenwork',
  providerName: 'QwenWork',
  config: {
    ...(wb.config?.group !== undefined ? { group: wb.config.group } : { group: 'standard-personal' }),
    access,
    api: { type: 'openai-chat-completions', baseUrl: `${base}/v1` },
    personalModelIds: [...MODEL_IDS],
    modelOrder: [...MODEL_IDS],
  },
})
rulesDoc.config.providerConfigRules.providerRules = filtered
if (Array.isArray(rulesDoc.config.providerOrder) && !rulesDoc.config.providerOrder.includes('qwenwork')) {
  rulesDoc.config.providerOrder.unshift('qwenwork')
}
atomicWrite(rulesPath, rulesDoc)
const checkRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
const rule = checkRules.config.providerConfigRules.providerRules.find(r => r.providerId === 'qwenwork')
console.log('rules layer:', rule ? `✅ qwenwork | ${rule.config.api.baseUrl} | ${rule.config.personalModelIds.length} models` : '❌ missing')
console.log('rules now:', checkRules.config.providerConfigRules.providerRules.map(r => r.providerId).join(', '))

// --- 2. registry layer --------------------------------------------------------
const QWENWORK_KEY = '9a3f7c21-6b8d-4e5a-9c2f-1d4b7e8a5f03'
const doc = JSON.parse(fs.readFileSync(configPath, 'utf8'))
doc.provider ??= {}
const models = {}
for (const row of rows) {
  models[row.id] = {
    name: row.display_name ?? row.id,
    limit: { context: row.context_window ?? 1000000, output: row.max_output_tokens ?? 32000 },
    modalities: { input: row.supports_images ? ['text', 'image'] : ['text'], output: ['text'] },
  }
}
doc.provider[QWENWORK_KEY] = {
  name: 'QwenWork',
  kind: 'openai-compatible',
  options: { apiKey: bearer || 'endpoint-token', baseURL: `${base}/v1`, apiKeyRequired: true },
  source: 'custom',
  models,
}
atomicWrite(configPath, doc)
const check = JSON.parse(fs.readFileSync(configPath, 'utf8'))
console.log('registry layer:', check.provider?.[QWENWORK_KEY] ? `✅ ${QWENWORK_KEY} | ${Object.keys(check.provider[QWENWORK_KEY].models).length} models` : '❌ missing')

function atomicWrite(p, document) {
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, p)
}

console.log('\n完成。重新打开 ZCode —— 模型选择器应出现 QwenWork 分组(pro / qwen3.8-flash / qwen3.8-max-preview)。')
