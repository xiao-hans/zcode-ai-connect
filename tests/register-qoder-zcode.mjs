// register-qoder-zcode.mjs — write the Qoder provider entry into ZCode's
// v2/config.json provider registry (the picker's data source), and keep the
// WorkBuddy entry's apiKey in sync with its endpoint.json.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { join } from 'node:path'

const home = os.homedir()
const cfgPath = join(home, '.zcode', 'v2', 'config.json')
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
cfg.provider ??= {}

// Qoder entry — stable UUID so re-runs update in place.
const QODER_KEY = 'q1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c'
const qEp = JSON.parse(fs.readFileSync(join(home, '.zcode-qoder-connect', 'endpoint.json'), 'utf8'))
const qBase = `http://127.0.0.1:${qEp.port || 39270}/v1`
const modelsR = await fetch(`${qBase}/models`, { headers: { Authorization: `Bearer ${qEp.token}` }, signal: AbortSignal.timeout(15000) })
const modelsJson = await modelsR.json()
const rows = modelsJson.data ?? []

const models = {}
for (const row of rows) {
  if (row.id === 'qoder-auto') continue // user asked to drop auto entries
  models[row.id] = {
    name: row.display_name ?? row.id,
    limit: { context: row.context_window ?? 180000, output: row.max_output_tokens ?? 32000 },
    modalities: { input: row.supports_images ? ['text', 'image'] : ['text'], output: ['text'] },
  }
}

cfg.provider[QODER_KEY] = {
  name: 'Qoder',
  kind: 'openai-compatible',
  options: { apiKey: qEp.token, baseURL: qBase, apiKeyRequired: true },
  source: 'custom',
  models,
}

// WorkBuddy: keep the entry's apiKey in sync with the current endpoint.json.
const wbEp = JSON.parse(fs.readFileSync(join(home, '.zcode-workbuddy-connect', 'endpoint.json'), 'utf8'))
for (const [key, entry] of Object.entries(cfg.provider)) {
  if (entry?.options?.baseURL?.includes(':39271') && entry.options.apiKey !== wbEp.token) {
    entry.options.apiKey = wbEp.token
    console.log('workbuddy entry apiKey refreshed')
  }
}

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
console.log('qoder provider written:', QODER_KEY, '| models:', Object.keys(models).length)
console.log('models:', Object.keys(models).join(', '))
