/**
 * pi-connect-services — ensure the local model endpoints are running when pi
 * starts (qoder 39270 / workbuddy 39271 / trae 39272).
 *
 * The three connect tools each serve an OpenAI-compatible loopback endpoint
 * that pi's custom providers point at. ZCode starts them via its SessionStart
 * hook; this extension gives pi the same behaviour so opening EITHER app
 * brings the stack up.
 *
 * Probe-then-spawn, fully detached, best-effort: a failed spawn never blocks
 * or breaks the session. But "best-effort" does not mean "silent" — when the
 * tools cannot be located at all the extension says so, because the symptom
 * otherwise looks like an unrelated provider/connection error.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)

const SERVICES = [
  { name: 'qoder', tool: 'zcode-qoder-connect', port: 39270, state: '.zcode-qoder-connect' },
  { name: 'workbuddy', tool: 'zcode-workbuddy-connect', port: 39271, state: '.zcode-workbuddy-connect' },
  { name: 'trae', tool: 'zcode-trae-connect', port: 39272, state: '.zcode-trae-connect' },
]

/** Walk up from *entryFile* to the nearest directory holding package.json. */
function packageRootOf(entryFile, maxUp = 4) {
  let dir = dirname(entryFile)
  for (let i = 0; i <= maxUp; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/**
 * Locate a connect tool's directory.
 *
 * 1. PI_CONNECT_TOOLS_ROOT — explicit override, always wins.
 * 2. The npm dependency (`zcode-*-connect` ships bin/cli.mjs). This is what
 *    makes a plain `pi install npm:pi-connect-services` work: no sibling
 *    layout, no env var, nothing to configure.
 * 3. The sibling layout — <suite repo root>/<tool> next to this extension,
 *    which is how the monorepo checkout (and a path install) is shaped.
 *
 * Returns { dir, via } or null when the tool cannot be found anywhere.
 */
export function locateTool(tool) {
  const candidates = []

  // Every candidate below is the *tool* directory, so the single
  // `bin/cli.mjs` probe at the end is valid for all of them.
  const envRoot = process.env.PI_CONNECT_TOOLS_ROOT
  if (envRoot) {
    // The env var names the suite root, which holds <tool>/ as children.
    candidates.push({ dir: join(envRoot, tool), via: 'PI_CONNECT_TOOLS_ROOT' })
  }
  try {
    const root = packageRootOf(require_.resolve(tool))
    if (root) candidates.push({ dir: root, via: 'npm dependency' })
  } catch {
    // Not installed as a dependency — fall through.
  }
  candidates.push({ dir: join(dirname(HERE), tool), via: 'sibling layout' })

  for (const candidate of candidates) {
    if (existsSync(join(candidate.dir, 'bin', 'cli.mjs'))) return candidate
  }
  return null
}

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

function emit(pi, level, message) {
  const logger = pi?.logger
  const write = logger?.[level] ?? logger?.info
  if (typeof write === 'function') {
    try {
      write.call(logger, message)
      return
    } catch {
      // fall through to console
    }
  }
  if (level === 'warn') console.warn(message)
}

async function ensure(service) {
  const token = await endpointToken(service.state)
  if (await healthy(service.port, token)) return `${service.name}: already up`

  const found = locateTool(service.tool)
  if (!found) {
    return `${service.name}: FAILED — ${service.tool} not found (set PI_CONNECT_TOOLS_ROOT, or reinstall ${service.tool})`
  }
  const cli = join(found.dir, 'bin', 'cli.mjs')
  try {
    const child = spawn(process.execPath, [cli, 'serve', '--port', String(service.port)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: found.dir,
    })
    child.unref()
    return `${service.name}: spawned (pid ${child.pid}, via ${found.via})`
  } catch (error) {
    return `${service.name}: FAILED — spawn error ${String(error).slice(0, 80)}`
  }
}

export default function connectServicesExtension(pi) {
  // Fire and forget: startup must not wait on network probes or spawns.
  void Promise.all(SERVICES.map(ensure)).then(results => {
    const failed = results.some(r => r.includes('FAILED'))
    emit(pi, failed ? 'warn' : 'info', `[pi-connect-services] ${results.join(' | ')}`)
  })
}
