/**
 * pi-connect-services — ensure the local model endpoints are running when pi
 * starts (trae 39272 / workbuddy 39271 / qoder 39270).
 *
 * The three connect tools (siblings of this directory in the suite repo)
 * each serve an OpenAI-compatible loopback endpoint that pi's custom
 * providers point at. ZCode starts them via its SessionStart hook; this
 * extension gives pi the same behaviour so opening EITHER app brings the
 * stack up.
 *
 * Probe-then-spawn, fully detached, best-effort: a failed spawn never blocks
 * or breaks the session — the provider just reports unreachable and the user
 * sees it in the model error, same as before.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 套件仓库根 = 本扩展所在目录的上一级;环境变量可覆盖。
const TOOLS_ROOT = process.env.PI_CONNECT_TOOLS_ROOT
  ?? dirname(dirname(fileURLToPath(import.meta.url)))
const SERVICES = [
  { name: 'qoder', tool: 'zcode-qoder-connect', port: 39270, state: '.zcode-qoder-connect' },
  { name: 'workbuddy', tool: 'zcode-workbuddy-connect', port: 39271, state: '.zcode-workbuddy-connect' },
  { name: 'trae', tool: 'zcode-trae-connect', port: 39272, state: '.zcode-trae-connect' },
]

async function endpointToken(stateDir) {
  try {
    const document = JSON.parse(await readFile(join(process.env.USERPROFILE ?? '', stateDir, 'endpoint.json'), 'utf8'))
    return typeof document.token === 'string' ? document.token : ''
  } catch {
    return ''
  }
}

async function healthy(port, token, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: token === '' ? {} : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.ok === true
  } catch {
    return false
  }
}

async function ensure(service) {
  try {
    const token = await endpointToken(service.state)
    if (await healthy(service.port, token)) return `${service.name}: already up`
    const child = spawn(process.execPath, [join(TOOLS_ROOT, service.tool, 'bin', 'cli.mjs'), 'serve', '--port', String(service.port)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: join(TOOLS_ROOT, service.tool),
    })
    child.unref()
    return `${service.name}: spawned (pid ${child.pid})`
  } catch (error) {
    return `${service.name}: spawn failed — ${String(error).slice(0, 80)}`
  }
}

export default function connectServicesExtension(pi) {
  // Fire and forget: startup must not wait on network probes or spawns.
  void Promise.all(SERVICES.map(ensure)).then(results => {
    try {
      pi.logger?.info?.(`[pi-connect-services] ${results.join(' | ')}`)
    } catch {
      // No logger surface on this pi version — silence is fine.
    }
  })
}
