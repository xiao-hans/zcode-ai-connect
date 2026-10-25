#!/usr/bin/env node
// cli.mjs — zcode-qoder-connect command line.
//
//   serve            run the loopback OpenAI-compatible endpoint (default)
//   status           credential tracks, credits, model roster
//   refresh          re-pull the model roster
//   checkin          claim today's Qoder check-in credits (+100/day)
//   login <PAT>      save a personal access token (qoder.cn → 账号设置)
//   logout           drop the saved PAT (desktop vault untouched)
//   service-status   is the endpoint up
//   doctor           credential + upstream diagnostics

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const { defaultStateDir, configureStateDir, configureEndpoint, stateDir, endpointPath } = await import(new URL('../src/config.js', import.meta.url).href)
const { QoderCredentialStore, patPath, SIGN_IN_HINT } = await import(new URL('../src/credentials.js', import.meta.url).href)
const { QoderUpstreamClient } = await import(new URL('../src/upstream.js', import.meta.url).href)
const { QoderCatalog } = await import(new URL('../src/catalog.js', import.meta.url).href)
const { createQoderServer } = await import(new URL('../src/server.js', import.meta.url).href)

const HELP = `zcode-qoder-connect — Qoder CN 模型接入本地 OpenAI 端点

用法: node bin/cli.mjs <command> [options]

commands:
  serve [--port N]    启动本地 OpenAI 兼容端点(默认 39270)
  status              凭据双轨状态、积分、模型名册
  refresh             重新拉取模型名册
  checkin             领取今日签到积分(+100/天)
  login <PAT>         保存个人访问令牌(qoder.cn → 账号设置 → 个人访问令牌)
  logout              删除已保存的 PAT(不影响 Qoder 桌面)
  service-status      端点是否在运行
  doctor              诊断

凭据双轨:
  1. PAT(pat.txt)— 生成: https://qoder.cn/account/integrations
  2. Qoder CN 桌面登录(auth.v1.dat,只读;dt- 过期时需打开一次 Qoder)`

const args = process.argv.slice(2)
const command = args.find(a => !a.startsWith('--')) ?? 'serve'
const portArg = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 39270

configureStateDir(defaultStateDir())
mkdirSync(stateDir(), { recursive: true })

// --- endpoint token (stable across restarts) --------------------------------
function ensureToken() {
  const p = endpointPath()
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (j.token && j.port) {
        configureEndpoint({ port: j.port, token: j.token })
        return j.token
      }
    } catch {}
  }
  const token = randomBytes(24).toString('base64url')
  writeFileSync(p, JSON.stringify({ token, port: portArg, createdAt: new Date().toISOString() }, null, 2), 'utf8')
  configureEndpoint({ port: portArg, token })
  return token
}

function buildStore() {
  return new QoderCredentialStore({ stateDir: stateDir() })
}
function buildClient() {
  return new QoderUpstreamClient({})
}

async function main() {
  if (command === 'help' || args.includes('--help')) { console.log(HELP); return }

  if (command === 'login') {
    const pat = args.find((a, i) => i > 0 && !a.startsWith('--') && args[i - 1] !== '--port' && a !== 'login')
    if (!pat) { console.error('用法: node bin/cli.mjs login <PAT>'); process.exitCode = 2; return }
    // live-validate before saving
    const { exchangePat } = await import(new URL('../src/credentials.js', import.meta.url).href)
    try {
      const data = await exchangePat(pat)
      if (!data?.token) throw new Error('兑换未返回 job token')
      writeFileSync(patPath(stateDir()), pat, 'utf8')
      console.log('PAT 有效并已保存(有效期至 ' + (data.expires_at ?? data.expires_in + 's') + ')')
    } catch (e) {
      console.error('PAT 校验失败,未保存:', String(e.message ?? e).slice(0, 200)); process.exitCode = 2
    }
    return
  }

  if (command === 'logout') {
    if (existsSync(patPath(stateDir()))) { unlinkSync(patPath(stateDir())); console.log('PAT 已删除(桌面登录不受影响)') }
    else console.log('没有已保存的 PAT')
    return
  }

  if (command === 'service-status') {
    const token = ensureToken()
    try {
      const r = await fetch(`http://127.0.0.1:${portArg}/healthz`, { headers: { Authorization: `Bearer ${token}` } })
      console.log(r.ok ? `endpoint http://127.0.0.1:${portArg}/v1 — up` : `endpoint responded HTTP ${r.status}`)
    } catch {
      console.log(`endpoint http://127.0.0.1:${portArg}/v1 — NOT reachable`)
      console.log('  启动: node bin/cli.mjs serve')
    }
    return
  }

  if (command === 'checkin') {
    const store = buildStore()
    const client = buildClient()
    try {
      const credential = await store.resolve()
      console.log(`凭据来源: ${credential.source}`)
      const result = await client.checkin(credential)
      if (result.status === 'claimed') console.log(`签到成功: +${result.amount} credits`)
      else if (result.status === 'already-claimed') console.log(`今日已签到(+${result.amount})`)
      else console.log(`签到未完成: ${result.status} ${result.message ?? ''}`)
    } catch (e) {
      console.log('签到失败 —', String(e.message ?? e).slice(0, 220))
    }
    return
  }

  if (command === 'status' || command === 'doctor' || command === 'refresh') {
    const store = buildStore()
    const st = store.status()
    console.log(`PAT:       ${st.patConfigured ? '已配置' : '未配置'}`)
    console.log(`桌面 vault: ${st.desktopVault ? '存在' : '不存在'}${st.desktopVault ? (st.desktopTokenFresh ? '(dt- 有效)' : '(dt- 已过期 → 打开一次 Qoder CN 桌面即可刷新)') : ''}`)
    if (command !== 'refresh') {
      try {
        const client = buildClient()
        const credential = await store.resolve()
        console.log(`凭据:      ${credential.source} (user ${credential.userID})`)
        try {
          const credits = await client.fetchCredits(credential)
          console.log('积分:', JSON.stringify(credits).slice(0, 200))
        } catch (e) { console.log('积分: 查询失败 —', String(e.message ?? e).slice(0, 120)) }
        const models = await client.fetchModels(credential)
        console.log(`Models (${models.length}):`)
        for (const m of models) {
          console.log(`  ${m.id.padEnd(30)} ${m.name.padEnd(24)} ${m.contextWindow} ctx${m.supportsImages ? '  img' : ''}${m.reasoning?.supportedEfforts?.length ? '  efforts ' + m.reasoning.supportedEfforts.join('/') : ''}${m.priceFactor !== undefined ? '  x' + m.priceFactor : ''}`)
        }
      } catch (e) {
        console.log('凭据不可用 —', String(e.message ?? e).slice(0, 240))
      }
      return
    }
    // refresh falls through to serve-side catalog refresh below when live
    try {
      const client = buildClient()
      const credential = await store.resolve()
      const models = await client.fetchModels(credential)
      console.log(`refreshed ${models.length} models`)
    } catch (e) {
      console.log('refresh 失败 —', String(e.message ?? e).slice(0, 200)); process.exitCode = 1
    }
    return
  }

  if (command === 'serve') {
    const token = ensureToken()
    const store = buildStore()
    const client = buildClient()
    const catalog = new QoderCatalog()
    const server = createQoderServer({
      token,
      port: portArg,
      client,
      variants: [{ id: 'qoder', path: '', prefix: '', store, catalog }],
    })
    await server.start()
    console.log(`[zcode-qoder-connect] listening on http://127.0.0.1:${server.port()}`)
    console.log(`[zcode-qoder-connect] OpenAI base: http://127.0.0.1:${server.port()}/v1`)
    console.log(`[zcode-qoder-connect] bearer: ${token}`)
    // initial catalog load (best-effort)
    try {
      const credential = await store.resolve()
      const models = await client.fetchModels(credential)
      catalog.set(models, { source: 'qoder-directory', fetchedAtMs: Date.now() })
      catalog.setVisible(true)
      console.log(`[zcode-qoder-connect] catalog: ${models.length} models`)
    } catch (e) {
      console.log(`[zcode-qoder-connect] catalog 未加载 — ${String(e.message ?? e).slice(0, 160)}`)
    }
    const shutdown = signal => {
      console.log(`\n[zcode-qoder-connect] ${signal} — shutting down`)
      server.close().then(() => process.exit(0))
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    return
  }

  console.error(`未知命令: ${command}\n`)
  console.log(HELP)
  process.exitCode = 2
}

main().catch(error => {
  console.error('fatal:', error)
  process.exit(1)
})
