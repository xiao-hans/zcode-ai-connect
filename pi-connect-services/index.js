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
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { detectStall, EMPTY_TURN_PROMPT } from './lib/stall-detector.mjs'

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
 * 2. The npm dependency, located by resolving the package entry. Works for
 *    tools that declare `main`/`exports`.
 * 3. A nested dependency: <here>/node_modules/<tool>, which is where npm puts
 *    a dependency when the top level is taken by a conflicting version.
 * 4. The parent directory: <parent>/<tool>. Under `pi install npm:` the parent
 *    is node_modules, so this is the normal flat install; in a monorepo
 *    checkout it is the suite root, i.e. the sibling layout.
 *
 * Step 4 is what keeps this working for tools that ship neither `main` nor
 * `exports` (resolving those throws MODULE_NOT_FOUND) — do not drop it.
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
    // No resolvable entry (or not installed) — fall through.
  }
  candidates.push({ dir: join(HERE, 'node_modules', tool), via: 'nested dependency' })
  const parent = dirname(HERE)
  candidates.push({
    dir: join(parent, tool),
    via: basename(parent) === 'node_modules' ? 'npm (flat)' : 'sibling layout',
  })

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

/** 同一条用户输入之后最多自动续跑几次。 */
export const MAX_AUTO_CONTINUES = 2

/**
 * 自带 stall 守卫的 provider —— 它们的 stall 交给自己的扩展处理，这里只补空回合。
 * 空回合谁都没管（判定器对空文本返回 empty），所以对所有 provider 都生效。
 */
const PROVIDERS_WITH_OWN_STALL_GUARD = new Set(['qwenwork'])

/** 一条 assistant 消息里可见的正文（thinking 不算）。 */
function visibleTextOf(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(b => b?.type === 'text').map(b => String(b.text ?? '')).join('')
}

/**
 * 收尾守卫：模型「什么都没给就收工」时补一轮。
 *
 * 两类：
 *  1. 空回合 —— 只留下 thinking，正文为空、也没调工具。用户看到的就是
 *     「思考着，突然不工作了」。
 *  2. stall —— 宣布了下一步却没动手。只对没有自带守卫的 provider 生效，
 *     否则会和 pi-provider-qwenwork 塞两条提示。
 *
 * 只在这一轮正常完成（outcome === 'completed'）时介入：用户中断/出错的回合
 * 不续跑 —— 这正是 dsh 0.2.1 修的那个坑。
 */
export function installTurnGuard(pi) {
  let autoContinues = 0

  pi.on('input', () => {
    autoContinues = 0
    return { action: 'continue' }
  })

  pi.on('agent_before_settle', event => {
    try {
      if (event?.continue) return undefined
      if (event?.outcome !== 'completed') return undefined

      const last = event.context?.llmMessages?.at(-1)
      if (!last || last.role !== 'assistant') return undefined
      if (last.stopReason !== 'stop') return undefined
      if ((last.content ?? []).some(b => b?.type === 'toolCall')) return undefined

      const text = visibleTextOf(last)
      const provider = last.provider

      let prompt = null
      let kind = ''
      if (text.trim() === '') {
        prompt = EMPTY_TURN_PROMPT
        kind = 'empty-turn'
      } else if (!PROVIDERS_WITH_OWN_STALL_GUARD.has(provider)) {
        const result = detectStall(text, { toolCallCount: 0 })
        if (result.stall && result.prompt) {
          prompt = result.prompt
          kind = `stall(score=${result.score}, ${result.signals.join('+')})`
        }
      }
      if (!prompt) return undefined
      if (autoContinues >= MAX_AUTO_CONTINUES) {
        emit(pi, 'info', `[pi-connect-services] turn-guard budget exhausted (${MAX_AUTO_CONTINUES}); leaving the turn alone`)
        return undefined
      }

      autoContinues += 1
      emit(pi, 'info', `[pi-connect-services] turn-guard: ${kind} on provider=${provider ?? 'unknown'}; one more turn (${autoContinues}/${MAX_AUTO_CONTINUES})`)

      return {
        entries: [
          ...(event.entries ?? []),
          { type: 'custom_message', customType: 'pi-connect-services-turn-guard', content: prompt, display: true },
        ],
        continue: true,
      }
    } catch (error) {
      emit(pi, 'info', `[pi-connect-services] turn-guard skipped due to error`)
      return undefined
    }
  })
}

export default function connectServicesExtension(pi) {
  // Fire and forget: startup must not wait on network probes or spawns.
  void Promise.all(SERVICES.map(ensure)).then(results => {
    const failed = results.some(r => r.includes('FAILED'))
    emit(pi, failed ? 'warn' : 'info', `[pi-connect-services] ${results.join(' | ')}`)
  })

  // 守卫放在这里而不是 pi-provider-qwenwork：后者在 startChatShim() 失败时
  // 直接 return，没装/没登录 qwenwork 时守卫会整体消失。
  try {
    installTurnGuard(pi)
  } catch (error) {
    emit(pi, 'warn', `[pi-connect-services] turn-guard install failed: ${String(error?.message ?? error)}`)
  }
}
