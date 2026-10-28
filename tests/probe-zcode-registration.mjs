// probe-zcode-registration.mjs — find how ZCode actually registers providers:
// what workbuddy's setup writes, and where.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = os.homedir()
const suiteRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))

// 1) workbuddy cli.js: every write target it mentions
const cliPath = path.join(suiteRoot, 'zcode-workbuddy-connect', 'src', 'cli.js')
const cli = fs.readFileSync(cliPath, 'utf8')
const lines = cli.split('\n')
console.log('=== cli.js 写文件/路径相关行 ===')
lines.forEach((l, i) => {
  if (/writeFile|provider_config|config\.json|providerConfig|writeProvider|setup/i.test(l)) {
    console.log((i + 1) + ': ' + l.trim().slice(0, 160))
  }
})

// 2) dump provider_config.json workbuddy vs qoder rules (full)
const pcPath = path.join(home, '.zcode', 'v2', 'provider_config.json')
const pc = JSON.parse(fs.readFileSync(pcPath, 'utf8'))
const rules = pc.config?.providerConfigRules?.providerRules ?? []
const wb = rules.find(r => r.providerId === 'workbuddy')
const qd = rules.find(r => r.providerId === 'qoder')
console.log('\n=== workbuddy rule (full) ===')
console.log(JSON.stringify(wb, null, 1).slice(0, 1400))
console.log('\n=== qoder rule (full) ===')
console.log(JSON.stringify(qd, null, 1).slice(0, 1400))

// 3) what files exist under ~/.zcode/v2 (and recent mtimes)
const v2 = path.join(home, '.zcode', 'v2')
console.log('\n=== ~/.zcode/v2 内容 ===')
for (const f of fs.readdirSync(v2)) {
  try {
    const st = fs.statSync(path.join(v2, f))
    console.log('  ' + f + '  ' + Math.round(st.size / 1024) + 'KB  mtime=' + st.mtime.toISOString().slice(0, 19))
  } catch { console.log('  ' + f) }
}
