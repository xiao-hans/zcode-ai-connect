#!/usr/bin/env node
// cli.mjs — zcode-qwenwork-connect command line.
//
//   serve            run the loopback OpenAI-compatible endpoint (default)
//   status           sign-in state, quota, model roster
//   doctor           credential + endpoint + WASM signer diagnostics
//   service-status   is the endpoint up
//
// Credentials are read-only from the 千问办公 (QwenWorkCN) desktop app's own
// sign-in (DPAPI + AES-GCM auth-v2.dat); there is nothing to log in here. If
// the desktop app is signed out, open it once.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const { defaultStateDir, configureStateDir, configureEndpoint, stateDir, endpointPath, DEFAULT_PORT } =
  await import(new URL('../src/config.js', import.meta.url).href)
const { createQwenworkServer } = await import(new URL('../src/server.js', import.meta.url).href)

const HELP = `zcode-qwenwork-connect — 千问办公(QwenWork)模型接入本地 OpenAI 端点

用法: node bin/cli.mjs <command> [options]

commands:
  serve [--port N]    启动本地 OpenAI 兼容端点(默认 39269)
  status              登录态、额度、模型名册
  doctor              凭据 + 端点 + WASM 签名器诊断
  service-status      端点是否在运行

凭据:
  只读复用千问办公桌面 App 的登录态(%APPDATA%\\QwenWorkCN\\auth-v2.dat)。
  报"未登录"时,打开一次千问办公桌面 App 即可。`

const args = process.argv.slice(2)
const command = args.find(a => !a.startsWith('--')) ?? 'serve'
const portArg = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : DEFAULT_PORT

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

async function main() {
  if (command === 'help' || args.includes('--help')) {
    console.log(HELP)
    return
  }

  if (command === 'service-status') {
    const token = ensureToken()
    try {
      const r = await fetch(`http://127.0.0.1:${portArg}/healthz`, { signal: AbortSignal.timeout(3000) })
      console.log(r.ok ? `endpoint http://127.0.0.1:${portArg}/v1 — up` : `endpoint responded HTTP ${r.status}`)
    } catch {
      console.log(`endpoint http://127.0.0.1:${portArg}/v1 — NOT reachable`)
      console.log('  启动: node bin/cli.mjs serve')
    }
    return
  }

  const { probeCredentials, describeCredentials } = await import(
    new URL('../vendor/lib/credentials.js', import.meta.url).href
  )

  if (command === 'doctor') {
    const probe = probeCredentials()
    if (!probe.ok) {
      console.log('凭据: ✗', probe.error?.message ?? 'unknown')
      if (probe.error?.recovery) console.log('  处理:', probe.error.recovery)
      return
    }
    const creds = probe.credentials
    console.log('凭据: ✓', describeCredentials(creds))
    const { resolveGatewayEndpoint } = await import(new URL('../vendor/lib/endpoint.js', import.meta.url).href)
    console.log('网关:', resolveGatewayEndpoint(creds))
    try {
      const { loadSignerModule } = await import(new URL('../vendor/lib/signer-session.js', import.meta.url).href)
      await loadSignerModule()
      console.log('WASM 签名器: ✓ 已加载')
    } catch (e) {
      console.log('WASM 签名器: ✗', String(e?.message ?? e).slice(0, 200))
    }
    return
  }

  if (command === 'status') {
    const { getValidCredential, fetchQuota } = await import(
      new URL('../vendor/lib/credentials-seam.js', import.meta.url).href
    )
    const { FALLBACK_QWENWORK_MODELS, displayName } = await import(
      new URL('../vendor/lib/models.js', import.meta.url).href
    )
    const probe = probeCredentials()
    console.log('登录态:', probe.ok ? '✓' : `✗ ${probe.error?.message ?? '?'}`)
    if (probe.ok) console.log('  ', describeCredentials(probe.credentials))
    try {
      await getValidCredential()
      console.log('token: 有效(过期会自动刷新)')
    } catch (e) {
      console.log('token: ✗', String(e?.message ?? e).slice(0, 200))
    }
    try {
      const quota = await fetchQuota()
      console.log('额度:', JSON.stringify(quota))
    } catch (e) {
      console.log('额度: 查询失败 —', String(e?.message ?? e).slice(0, 160))
    }
    console.log(`Models (${FALLBACK_QWENWORK_MODELS.length}):`)
    for (const m of FALLBACK_QWENWORK_MODELS) {
      console.log(`  ${(m.displayNameId ?? m.id).padEnd(24)} ${displayName(m).padEnd(28)} ${(m.contextWindow / 1000) | 0}K ctx  ${m.maxTokens} out  img`)
    }
    return
  }

  if (command === 'serve') {
    const token = ensureToken()
    const server = createQwenworkServer({ token, port: portArg })
    await server.start()
    console.log(`[zcode-qwenwork-connect] listening on http://127.0.0.1:${portArg}`)
    console.log(`[zcode-qwenwork-connect] OpenAI base: http://127.0.0.1:${portArg}/v1`)
    console.log(`[zcode-qwenwork-connect] bearer: ${token}`)
    const shutdown = signal => {
      console.log(`\n[zcode-qwenwork-connect] ${signal} — shutting down`)
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
