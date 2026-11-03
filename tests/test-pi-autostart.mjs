/**
 * pi-connect-services 的「自动拉起端点」开关。
 *
 * 关掉自动拉起后,扩展仍然装 stall 守卫,只是不再探测/spawn —— 否则用户
 * 手动管理端点时,每次开 pi 都会被静默 spawn 一次,端口被占、日志变脏。
 *
 *   node tests/test-pi-autostart.mjs
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODULE = new URL('../pi-connect-services/index.js', import.meta.url).href
const realHome = process.env.USERPROFILE
const fakeHome = join(tmpdir(), `pi-autostart-${process.pid}`)
mkdirSync(join(fakeHome, '.zcode-ai-connect'), { recursive: true })

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`ok ${passed}. ${label}`)
  } else {
    failed += 1
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
  }
}

process.env.USERPROFILE = fakeHome
delete process.env.PI_CONNECT_NO_AUTOSTART
const { autostartDisabled, default: connectServicesExtension } = await import(MODULE)

check('默认(无标记、无环境变量)会拉起端点', autostartDisabled() === false)
check('未打标记的 HOME 下不误判', autostartDisabled() === false)

process.env.PI_CONNECT_NO_AUTOSTART = '1'
check('PI_CONNECT_NO_AUTOSTART=1 关闭自动拉起', autostartDisabled() === true)
process.env.PI_CONNECT_NO_AUTOSTART = 'true'
check('PI_CONNECT_NO_AUTOSTART=true 同样关闭', autostartDisabled() === true)
process.env.PI_CONNECT_NO_AUTOSTART = '0'
check('PI_CONNECT_NO_AUTOSTART=0 不关闭', autostartDisabled() === false)
delete process.env.PI_CONNECT_NO_AUTOSTART

const marker = join(fakeHome, '.zcode-ai-connect', 'no-autostart')
writeFileSync(marker, '')
check('标记文件关闭自动拉起', autostartDisabled() === true)

// 扩展入口:标记存在时只提示、不 spawn;stall 守卫照旧安装。
const messages = []
const guardCalls = []
const pi = {
  logger: { info: (m) => messages.push(['info', m]), warn: (m) => messages.push(['warn', m]) },
  on: (event) => guardCalls.push(event),
}
const mod = await import(MODULE)
mod.default(pi)
await new Promise((r) => setTimeout(r, 300))
const text = messages.map(([, m]) => String(m)).join('\n')
check('标记存在时给出可解释提示', /autostart 已关闭/.test(text), text)
check('标记存在时没有 spawned 记录', !/spawned/.test(text), text)
check('stall 守卫仍然安装', guardCalls.length > 0, `guard events: ${guardCalls.join(',')}`)

rmSync(fakeHome, { recursive: true, force: true })
process.env.USERPROFILE = realHome
if (realHome === undefined) delete process.env.USERPROFILE

console.log(failed === 0 ? `\npi autostart: ${passed} passed, 0 failed` : `\npi autostart: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
