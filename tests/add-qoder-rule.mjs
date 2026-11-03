// add-qoder-rule.mjs — register the Qoder provider in the REAL rules layer
// (dataBaseDir-resolved provider_config.json) — this is the file the model
// dropdown actually reads. Shape mirrors the workbuddy/trae rules exactly.
import fs from 'node:fs'
import os from 'node:os'

// 按 register-qwenwork.mjs 的 dataBaseDir 惯例解析真实 v2 目录
import path from 'node:path'
const v2plain = path.join(os.homedir(), '.zcode', 'v2')
let v2dir = v2plain
try {
  const setting = JSON.parse(fs.readFileSync(path.join(v2plain, 'setting.json'), 'utf8'))
  if (typeof setting?.dataBaseDir === 'string' && setting.dataBaseDir !== '')
    v2dir = path.join(setting.dataBaseDir, '.zcode', 'v2')
} catch {}
const p = path.join(v2dir, 'provider_config.json')
const ep = JSON.parse(fs.readFileSync(`${os.homedir()}/.zcode-qoder-connect/endpoint.json`, 'utf8'))
const baseUrl = `http://127.0.0.1:${ep.port || 39270}/v1`
const MODEL_IDS = [
  'deepseek-v4-pro', 'deepseek-flash', 'qwen3.8-max', 'qwen3.8-flash',
  'glm-5.3', 'glm-5.3-flash', 'kimi-k3.1-pro', 'kimi-k2.8-preview',
  'minimax-m3.1-flash', 'qoder-fast',
]

const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
const rules = doc.config.providerConfigRules.providerRules

// drop any previous qoder rule, then add fresh
const filtered = rules.filter(r => r.providerId !== 'qoder')
const wb = rules.find(r => r.providerId === 'workbuddy') ?? {}
const template = wb.config ?? {
  group: 'standard-personal',
  access: { type: 'api-key', apiKey: ep.token },
  api: { type: 'openai-chat-completions', baseUrl },
  personalModelIds: MODEL_IDS,
  modelOrder: MODEL_IDS,
}
filtered.push({
  providerId: 'qoder',
  providerName: 'Qoder',
  config: {
    ...(template.group !== undefined ? { group: template.group } : {}),
    access: { type: 'api-key', apiKey: ep.token },
    api: { type: 'openai-chat-completions', baseUrl },
    personalModelIds: [...MODEL_IDS],
    modelOrder: [...MODEL_IDS],
  },
})
doc.config.providerConfigRules.providerRules = filtered

// keep providerOrder containing qoder
if (Array.isArray(doc.config.providerOrder) && !doc.config.providerOrder.includes('qoder')) {
  doc.config.providerOrder.unshift('qoder')
}

// atomic write
const tmp = p + '.' + process.pid + '.tmp'
fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
fs.renameSync(tmp, p)

// verify
const check = JSON.parse(fs.readFileSync(p, 'utf8'))
const q = check.config.providerConfigRules.providerRules.find(r => r.providerId === 'qoder')
console.log('qoder rule written:', q ? `✅ ${q.providerId} | ${q.providerName} | ${q.config.api.baseUrl} | ${q.config.personalModelIds.length} models` : '❌ missing')
console.log('rules now:', check.config.providerConfigRules.providerRules.map(r => r.providerId).join(', '))
