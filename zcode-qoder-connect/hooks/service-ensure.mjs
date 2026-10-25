#!/usr/bin/env node
/**
 * SessionStart hook: make sure the local Qoder endpoint is running.
 *
 * Same contract as zcode-trae-connect's hook: the provider entry in ZCode's
 * provider_config.json points at a fixed loopback port (39270), so something
 * has to be listening there before the first message. Self-verifying — the
 * spawn call alone never counts as success — and never fails the session.
 *
 * @module zcode-qoder-connect/hooks/service-ensure
 */

import { spawn } from 'node:child_process'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(pluginRoot, 'bin', 'cli.mjs')
const stateDir = process.env['ZCODE_QODER_CONNECT_HOME'] ?? join(process.env['USERPROFILE'] ?? '.', '.zcode-qoder-connect')
const endpointPath = join(stateDir, 'endpoint.json')
const logPath = join(stateDir, 'service.log')
const DEFAULT_PORT = 39270

async function log(line) {
  try {
    await mkdir(stateDir, { recursive: true })
    await appendFile(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

async function readEndpoint() {
  try {
    const document = JSON.parse(await readFile(endpointPath, 'utf8'))
    const token = typeof document['token'] === 'string' ? document['token'] : ''
    const port = typeof document['port'] === 'number' && document['port'] > 0 ? document['port'] : DEFAULT_PORT
    return { token, port }
  } catch {
    return { token: '', port: DEFAULT_PORT }
  }
}

async function healthy(port, token, timeoutMs = 2500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: token === '' ? {} : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.['ok'] === true
  } catch {
    return false
  }
}

async function waitForHealth(port, token, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (await healthy(port, token)) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

function spawnDetached(port) {
  const child = spawn(process.execPath, [cliPath, 'serve', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: pluginRoot,
  })
  child.unref()
  return child.pid
}

async function main() {
  if (!existsSync(cliPath)) {
    await log(`cli not found at ${cliPath}; skipping`)
    return
  }
  const { token, port } = await readEndpoint()

  if (await healthy(port, token)) {
    await log(`endpoint already healthy on :${port}`)
    return
  }

  let pid
  try {
    pid = spawnDetached(port)
    await log(`spawned detached pid ${pid} on :${port}`)
  } catch (error) {
    await log(`spawn refused: ${String(error)}`)
  }

  if (await waitForHealth(port, token)) {
    await log(`endpoint healthy on :${port}${pid === undefined ? '' : ` (pid ${pid})`}`)
    return
  }

  await log(`endpoint NOT healthy on :${port} after spawn attempt`)
  console.log(
    `[zcode-qoder-connect] The local endpoint is not running on port ${port}.`
    + ' Its models will fail until it is started. Start it in a terminal with:\n'
    + `  node "${cliPath}" serve --port ${port}\n`
    + '凭据提示: Qoder 桌面 dt- 过期时,打开一次 Qoder CN 桌面即可刷新。',
  )
}

main().catch(async error => {
  await log(`hook error: ${String(error)}`)
}).finally(() => {
  process.exit(0)
})
