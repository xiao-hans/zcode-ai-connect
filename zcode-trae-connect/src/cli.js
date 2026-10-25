#!/usr/bin/env node
/**
 * zcode-trae-connect CLI.
 *
 *   serve     run the loopback OpenAI-compatible endpoint (default)
 *   status    sign-in state, remaining credit, model roster
 *   refresh   re-pull the model roster from the upstream
 *   setup     write the ZCode provider entries for this endpoint
 *   doctor    check credentials, install detection, upstream reachability
 *   install-service       Register a logon task that keeps the endpoint running
 *   uninstall-service     Remove that logon task
 *   service-status        Report whether the task is registered and the endpoint is up
 *   logout    drop the plugin-owned credential copy
 *   token     print the endpoint bearer and exit
 *
 * @module zcode-trae-connect/cli
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TraeCredentialStore, discoverDesktopAuths } from './credentials.js'
import { TraeCatalog } from './catalog.js'
import { TraeUpstreamClient, applyDetectedInstall, detectInstall } from './upstream.js'
import { createTraeServer } from './server.js'
import {
  configureEndpoint,
  configureStateDir,
  defaultStateDir,
  endpointPath,
  loadToken,
  ownAuthIntlPath,
  ownAuthPath,
  setToken,
  stateDir,
} from './config.js'

/** Fixed loopback port the endpoint listens on by default. */
export const DEFAULT_PORT = 39272

const HELP = `zcode-trae-connect — use Trae desktop-app models from any OpenAI-compatible client

Usage: node bin/cli.mjs <command> [options]

Commands:
  serve                 Run the loopback OpenAI-compatible endpoint (default)
  status                Show sign-in state, token expiry, and the model roster
  refresh               Re-pull the model roster from the upstream
  setup                 Write the ZCode provider entries for this endpoint
  doctor                Check credentials, install detection, catalog, credits
  install-service       Register a logon task that keeps the endpoint running
  uninstall-service     Remove that logon task
  service-status        Report whether the task is registered and the endpoint is up
  logout                Drop the plugin-owned credential copy
  token                 Print the endpoint bearer and exit

Options:
  --port <n>            Fixed port for serve (default 39272; 0 = OS-assigned)
  --token <t>           Override the endpoint bearer
  --home <dir>          State directory (default ${defaultStateDir()})
  --data-dir-cn <path>  国内版 Trae data directory or storage.json (wins over the scan)
  --data-dir-intl <path> 国际版 Trae data directory or storage.json (wins over the scan)
  --intl-remote-base <url>   国际版 upstream override (default: auto-detect from the install)
  --intl-web-origin <url>    国际版 Web Origin override (default: auto-detect)
  --default-context-window
                        Advertise the model's softer default window instead of
                        its 1M max-mode profile when it has one (default: max)
  --keep-session        Do not delete the remote chat session after each turn
                        (即用即焚 is on by default)
  --config <path>       provider_config.json to write (setup only)
  --node <path>         Node executable for the autostart launcher (install-service
                        only; default: the system node, else this runtime)
  --json                Machine-readable output
  -h, --help            This text
`

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item.startsWith('--')) {
      const [flag, inline] = item.slice(2).split('=')
      const key = flag.replace(/-([a-z])/gu, (_, c) => c.toUpperCase())
      if (inline !== undefined) {
        args[key] = inline
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1]
        i += 1
      } else {
        args[key] = true
      }
    } else {
      args._.push(item)
    }
  }
  return args
}

function mask(value) {
  if (typeof value !== 'string' || value === '') return '(none)'
  return value.length <= 10 ? '***' : `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`
}

function formatTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '(unknown)'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

/** Load or create the persisted endpoint bearer. */
async function ensureToken(args) {
  if (typeof args.token === 'string' && args.token !== '') return args.token
  const path = endpointPath()
  try {
    const document = JSON.parse(await readFile(path, 'utf8'))
    if (typeof document['token'] === 'string' && document['token'] !== '') {
      return loadToken(document['token'])
    }
  } catch {
    // No persisted endpoint yet.
  }
  const token = randomBytes(32).toString('base64url')
  await mkdir(stateDir(), { recursive: true })
  await writeFile(path, `${JSON.stringify({ token, port: Number(args.port) || DEFAULT_PORT, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  setToken(token)
  return token
}

/** Live preference read; shared by every command that builds clients. */
function preferencesFor(args) {
  return {
    // Default: pin max-mode models to their 1M profile (the desktop client's
    // max session). `--default-context-window` opts back out to the softer
    // dev window.
    useMaximumContextWindow: () => args.defaultContextWindow !== true,
    // 即用即焚: delete the remote session after each turn so the account's
    // Trae session list does not fill up. `--keep-session` opts out.
    autoDeleteSession: () => args.keepSession !== true,
  }
}

/**
 * The two editions this service serves. Each gets its own credential store
 * (separate desktop data directory, separate owned copy, separate env
 * override), its own catalog and upstream client, and its own URL mount: the
 * root for 国内版, `/intl` for 国际版. The mount is what keeps the shared ids
 * (glm-5.3, kimi-k3…) distinct without polluting the id a client displays.
 */
const VARIANTS = [
  {
    id: 'cn',
    edition: 'cn',
    path: '',
    prefix: '',
    appName: 'Trae 国内版',
    providerId: 'trae',
    ownPath: ownAuthPath(),
  },
  {
    id: 'intl',
    edition: 'intl',
    path: '/intl',
    prefix: '',
    appName: 'Trae 国际版',
    providerId: 'trae-intl',
    ownPath: ownAuthIntlPath(),
  },
]

/**
 * Discover the desktop sign-ins, build one store + upstream client per
 * edition, and resolve each edition's remote gate from the installed app.
 *
 * Discovery is async (the edition verdict consults the installed app's
 * product.json, which shells out to the Windows uninstall registry on first
 * use), so it is awaited ONCE here and published into a cache; each store's
 * synchronous `discover` callback reads that cache and kicks a background
 * refresh, so a desktop re-login is picked up on the next resolve without
 * blocking it.
 */
async function buildStores(args) {
  const logger = console
  const preferences = preferencesFor(args)
  const explicitCnPath = args.dataDirCn ?? process.env.TRAE_DATA_DIR_CN
  const explicitIntlPath = args.dataDirIntl ?? process.env.TRAE_DATA_DIR_INTL
  const scan = await discoverDesktopAuths({ logger, explicitCnPath, explicitIntlPath })
  const cache = { cn: scan.results.cn, intl: scan.results.intl }

  /** One fresh discovery pass, published into the cache the stores read. */
  const refreshDesktopAuths = async () => {
    try {
      const next = await discoverDesktopAuths({ logger, quiet: true, explicitCnPath, explicitIntlPath })
      cache.cn = next.results.cn
      cache.intl = next.results.intl
    } catch {
      // A failed sweep keeps the last good scan; an unreadable storage.json is
      // not proof of sign-out.
    }
  }

  const intlOverrides = {
    remoteBase: String(args.intlRemoteBase ?? process.env.TRAE_INTL_REMOTE_BASE ?? '').trim(),
    webOrigin: String(args.intlWebOrigin ?? process.env.TRAE_INTL_WEB_ORIGIN ?? '').trim(),
  }

  const stores = []
  for (const variant of VARIANTS) {
    const store = new TraeCredentialStore({
      edition: variant.edition,
      logger,
      path: variant.ownPath,
      // intl refreshHost override: only a fallback — the credential record's
      // own host (the auth domain, live-verified) wins.
      ...(variant.edition === 'intl' ? { refreshHost: intlOverrides.remoteBase } : {}),
      discover: () => {
        void refreshDesktopAuths()
        return cache[variant.edition]
      },
    })
    store.load()
    stores.push({
      ...variant,
      store,
      client: new TraeUpstreamClient({
        edition: variant.edition,
        preferences,
        logger,
        overrides: variant.edition === 'intl' ? intlOverrides : {},
      }),
    })
  }

  // The remote gate is region-dependent (product.json picks a mirror per
  // account region), so detection runs per edition with THAT edition's region
  // taken from its own credential record. Detection only prefers the installed
  // app's hosts; a CLI/env override still wins over it, and a detection
  // failure must never stop the service from starting — either way the
  // compiled-in table applies.
  for (const { edition } of stores) {
    try {
      const region = String(cache[edition]?.userRegion?.region ?? '').trim()
      const install = await detectInstall(edition, region)
      applyDetectedInstall(edition, install)
      if (install.source !== 'compiled-in') {
        logger.info?.(`[trae] ${edition} 上游来自已安装程序（${install.appRoot}${region === '' ? '' : `，账号地区 ${region}`}）— ${install.remoteBase}`)
      }
    } catch (error) {
      applyDetectedInstall(edition, undefined)
      logger.warn?.(`[trae] ${edition} 安装检测失败（${String(error)}），沿用内置上游地址`)
    }
  }

  return { stores, scan, refreshDesktopAuths, preferences }
}

/** Preflight: parse the desktop sign-ins and report what a user can act on. */
async function commandDoctor(args) {
  const { stores, scan } = await buildStores(args)
  const report = { stateDir: stateDir(), checks: [] }

  for (const attempt of scan.attempts) {
    report.checks.push({
      name: `data dir ${attempt.dir}`,
      ok: attempt.ok === true,
      detail: attempt.ok === true
        ? `→ ${attempt.resolved} 版凭据可解密（${attempt.storage}）`
        : '无可用凭据',
    })
  }

  for (const { id, edition, appName, store, client } of stores) {
    const status = await store.status()
    report[`${id}AuthStatus`] = status
    report.checks.push({
      name: `${appName} signed in`,
      ok: status.state === 'signed-in',
      detail: status.state === 'signed-in'
        ? `user ${mask(status.userId)} · host ${status.host || '(none)'} · expires ${formatTime(status.expiresAt)} · source ${status.source}`
        : (status.reason ?? 'no credential found; sign in once in the Trae desktop app'),
    })

    if (status.state !== 'signed-in') continue

    try {
      const region = String(scan.results[edition]?.userRegion?.region ?? '').trim()
      const install = await detectInstall(edition, region)
      report.checks.push({
        name: `${appName} upstream`,
        ok: true,
        detail: `${install.source} — ${install.remoteBase}`,
      })
    } catch (error) {
      report.checks.push({ name: `${appName} upstream`, ok: false, detail: String(error) })
    }

    try {
      const credential = await store.resolve()
      const models = await client.fetchModels(credential)
      report.checks.push({ name: `${appName} catalog`, ok: true, detail: `${models.length} models from ${client.lastCatalog?.source}` })
      try {
        const credits = await client.fetchCredits(credential)
        report[`${id}Credits`] = credits
        report.checks.push({ name: `${appName} credit`, ok: true, detail: JSON.stringify(credits).slice(0, 160) })
      } catch (error) {
        report.checks.push({ name: `${appName} credit`, ok: false, detail: String(error) })
      }
    } catch (error) {
      report.checks.push({ name: `${appName} catalog`, ok: false, detail: String(error) })
    }
  }

  const token = await ensureToken(args)
  report.endpoint = { baseUrl: `http://127.0.0.1:${Number(args.port) || DEFAULT_PORT}/v1`, token: mask(token) }
  report.checks.push({ name: 'endpoint bearer', ok: token !== '', detail: report.endpoint.token })

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('zcode-trae-connect doctor')
    console.log(`  dir         ${report.stateDir}`)
    console.log(`  endpoint    ${report.endpoint.baseUrl}`)
    console.log(`  bearer      ${report.endpoint.token}`)
    console.log('')
    for (const check of report.checks) {
      console.log(`  [${check.ok ? ' OK ' : 'FAIL'}] ${check.name.padEnd(24)} ${check.detail}`)
    }
  }
  const failed = report.checks.filter(check => !check.ok)
  process.exitCode = failed.length === 0 ? 0 : 1
}

/** A model's picker label: display name plus the credit multiplier. */
function modelLabel(model) {
  const rate = model.traeRate
  const suffix = rate === undefined || rate === null
    ? ''
    : rate === 0 ? ' · 免费' : ` · x${rate}`
  return `${model.name}${suffix}`
}

async function commandStatus(args) {
  const { stores } = await buildStores(args)
  const report = {}
  const modelReports = []

  for (const { id, appName, store, client } of stores) {
    const status = await store.status()
    const entry = { auth: status }
    if (status.state === 'signed-in') {
      try {
        const credential = await store.resolve()
        const models = await client.fetchModels(credential)
        entry.models = models.map(model => ({
          id: model.id,
          name: modelLabel(model),
          contextWindow: model.contextWindow,
          maxContextWindow: model.maxContextWindow,
          maxTokens: model.maxTokens,
          efforts: model.traeEfforts ?? [],
          locked: model.locked === true,
        }))
        try {
          entry.credits = await client.fetchCredits(credential)
        } catch (error) {
          entry.creditsError = String(error)
        }
      } catch (error) {
        entry.catalogError = String(error)
      }
    }
    report[id] = entry
    modelReports.push({ id, appName, entry })
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const { appName, entry } of modelReports) {
    const status = entry.auth
    console.log(`\n=== ${appName} ===`)
    if (status.state !== 'signed-in') {
      console.log(`  Not signed in. ${status.reason ?? 'Sign in once in the Trae desktop app.'}`)
      continue
    }
    console.log(`  Signed in:    user ${mask(status.userId)} (source ${status.source})`)
    console.log(`  Token expires: ${formatTime(status.expiresAt)}`)
    const credits = entry.credits
    if (credits !== undefined) {
      console.log(`  Credits:       ${JSON.stringify(credits).slice(0, 200)}`)
    } else if (entry.creditsError !== undefined) {
      console.log(`  Credits:       lookup failed — ${entry.creditsError}`)
    }
    const models = entry.models ?? []
    console.log(`  Models (${models.length}):`)
    for (const model of models) {
      const flags = [
        model.locked ? 'LOCKED' : 'usable',
        model.efforts.length === 0 ? 'no explicit efforts' : `efforts ${model.efforts.join('/')}`,
        model.maxContextWindow === undefined ? '' : `max ${model.maxContextWindow}`,
      ].filter(part => part !== '').join(' · ')
      console.log(`    ${model.id.padEnd(26)} ${model.name.padEnd(24)} ${String(model.contextWindow).padStart(9)} ctx  ${flags}`)
    }
  }
}

async function commandRefresh(args) {
  const { stores } = await buildStores(args)
  for (const { appName, store, client } of stores) {
    try {
      const credential = await store.resolve()
      const models = await client.fetchModels(credential)
      if (args.json) {
        console.log(JSON.stringify({ variant: client.edition, source: client.lastCatalog?.source, count: models.length, ids: models.map(m => m.id) }, null, 2))
      } else {
        console.log(`${appName}: refreshed ${models.length} models from ${client.lastCatalog?.source}`)
        console.log(`  ${models.map(model => model.id).join(', ')}`)
      }
    } catch (error) {
      if (args.json) {
        console.log(JSON.stringify({ variant: client.edition, ok: false, error: String(error) }, null, 2))
      } else {
        console.log(`${appName}: refresh failed — ${String(error)}`)
      }
    }
  }
}

async function commandLogout(args) {
  const { stores } = await buildStores(args)
  for (const { appName, store } of stores) {
    store.forget()
    console.log(`Removed the plugin credential copy for ${appName} (the Trae desktop app's own sign-in is untouched).`)
  }
}

const AUTOSTART_BASENAME = 'zcode-trae-connect.vbs'

/** The current user's Startup folder, or undefined off Windows. */
function startupFolder() {
  const appData = process.env['APPDATA']
  if (appData === undefined || appData === '') return undefined
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

/** Path of the Startup-folder launcher, or undefined off Windows. */
function autostartPath() {
  const folder = startupFolder()
  return folder === undefined ? undefined : join(folder, AUTOSTART_BASENAME)
}

/**
 * Register the endpoint to start hidden at logon.
 *
 * The Startup folder rather than a scheduled task: creating a task needs
 * elevation on a locked-down host (it fails outright with access denied), while
 * the Startup folder is per-user and needs none. A VBS trampoline is what keeps
 * the console window from appearing — launching node.exe directly flashes a
 * console on every logon.
 *
 * A third policy layer can still refuse the write: some hosts block script
 * files (`.vbs`, `.cmd`, `.bat`, `.ps1`) from being created in the Startup
 * folder while allowing ordinary files beside them. That is a deliberate
 * security control, so this command reports it and stops rather than working
 * around it. Autostart is only the fallback path anyway: the plugin's
 * `SessionStart` hook is what normally brings the endpoint up.
 */
async function commandInstallService(args) {
  const target = autostartPath()
  if (target === undefined) {
    console.error('install-service supports Windows only (no %APPDATA%).')
    process.exitCode = 1
    return
  }
  const port = Number(args.port) || DEFAULT_PORT
  const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
  // Prefer a node that outlives whichever runtime happened to run this
  // command: a node under a tool's own managed directory (WorkBuddy's, say)
  // disappears the day that tool is cleaned up, which would silently kill
  // the autostart. The system nvm4w node is the one ZCode's own bundled
  // hooks already use, so it is the first candidate. `--node` overrides.
  const nodeCandidates = [
    args.node,
    process.env['ZCODE_TRAE_CONNECT_NODE'],
    'C:/nvm4w/nodejs/node.exe',
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0)
  const nodePath = nodeCandidates.find(candidate => existsSync(candidate)) ?? process.execPath

  const vbs = [
    "' ZCode Trae Connect — starts the local OpenAI-compatible endpoint hidden at logon.",
    "' Remove this file to disable autostart; it writes nothing else outside the state dir.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${nodePath}"" ""${cliPath}"" serve --port ${port}", 0, False`,
    '',
  ].join('\r\n')

  try {
    await writeFile(target, vbs, 'utf8')
  } catch (error) {
    const blocked = error?.code === 'EPERM' || error?.code === 'EACCES'
    console.error(`error: could not write ${target} (${error?.code ?? 'unknown'}).`)
    if (blocked) {
      console.error('  This host blocks script files in the Startup folder. Ordinary files can be')
      console.error('  written there, but .vbs/.cmd/.bat/.ps1 are refused — a deliberate policy, not a bug.')
    }
    console.error('')
    console.error('  Autostart is optional. The plugin\'s SessionStart hook already starts the')
    console.error('  endpoint whenever ZCode opens a session, which covers every use of these')
    console.error('  models from ZCode. Without it, the endpoint still comes up for any session')
    console.error('  begun after a logon; only a client talking to the port with ZCode closed')
    console.error('  would need autostart, and that can be started by hand:')
    console.error(`    node "${cliPath}" serve --port ${port}`)
    process.exitCode = 1
    return
  }

  if (args.json) {
    console.log(JSON.stringify({ autostart: target, nodePath, cliPath, port }, null, 2))
    return
  }
  console.log(`Registered logon autostart: ${target}`)
  console.log(`  command   "${nodePath}" "${cliPath}" serve --port ${port}`)
  console.log('')
  console.log('It starts at your next logon. To start it now without logging out:')
  console.log(`  wscript.exe "${target}"`)
}

async function commandUninstallService(args) {
  const target = autostartPath()
  if (target === undefined) {
    console.error('uninstall-service supports Windows only.')
    process.exitCode = 1
    return
  }
  const existed = existsSync(target)
  if (existed) await rm(target, { force: true })
  if (args.json) {
    console.log(JSON.stringify({ autostart: target, removed: existed }, null, 2))
    return
  }
  console.log(existed ? `Removed ${target}.` : `Nothing to remove (${target} did not exist).`)
}

/** Whether the endpoint answers on the configured port. */
async function probeEndpoint(port, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return { up: true, healthy: false, status: response.status }
    return { up: true, healthy: true, body: await response.json() }
  } catch {
    return { up: false, healthy: false }
  }
}

async function commandServiceStatus(args) {
  const port = Number(args.port) || DEFAULT_PORT
  const token = await ensureToken(args)
  const probe = await probeEndpoint(port, token)
  const target = autostartPath()
  const registered = target !== undefined && existsSync(target)
  const report = {
    autostartPath: target,
    autostartRegistered: registered,
    endpoint: `http://127.0.0.1:${port}/v1`,
    reachable: probe.up,
    healthy: probe.healthy,
    ...(probe.body === undefined ? {} : { state: probe.body }),
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`autostart     ${registered ? `registered (${target})` : 'not registered'}`)
  console.log(`endpoint      ${report.endpoint} — ${probe.up
    ? (probe.healthy ? `up (${probe.body?.models} models)` : `answering but unhealthy (HTTP ${probe.status})`)
    : 'NOT reachable'}`)
  if (!probe.up) {
    console.log('')
    console.log(registered
      ? `Start it with: wscript.exe "${target}"`
      : 'Register it with: node bin/cli.mjs install-service')
  }
}

/**
 * The root ZCode resolves its data documents against.
 *
 * ZCode splits settings from data: `setting.json` lives at the profile root
 * (`~/.zcode/v2/`) and carries `dataBaseDir`, while every data document —
 * including `provider_config.json`, the personal provider registry that feeds
 * the model picker — resolves as `<dataBaseDir>/.zcode/v2/<file>`. The
 * profile root is only the fallback for when `dataBaseDir` is unset.
 *
 * This is not theoretical: writing the registry at the profile root produces
 * a document that validates perfectly and that nothing reads, so file-written
 * providers never appear in the desktop picker. The app's own writes settle
 * it — adding a provider in the UI lands in
 * `<dataBaseDir>/.zcode/v2/provider_config.json` (mtime tracks the click).
 * `ZCODE_DATA_BASE_DIR` overrides the setting, mirroring the app's own
 * resolution order.
 */
function resolveZCodeDataRoot() {
  const fromEnv = process.env['ZCODE_DATA_BASE_DIR']?.trim()
  if (fromEnv) return fromEnv
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.zcode', 'v2', 'setting.json'), 'utf8'))
    const dir = typeof settings?.dataBaseDir === 'string' ? settings.dataBaseDir.trim() : ''
    if (dir) return dir
  } catch {
    // No settings document yet — the app falls back to the profile root.
  }
  return homedir()
}

/** Write the ZCode provider entries pointing at this endpoint (one per edition). */
async function commandSetup(args) {
  const token = await ensureToken(args)
  const port = Number(args.port) || DEFAULT_PORT
  const baseUrl = `http://127.0.0.1:${port}/v1`
  const configPath = args.config ?? join(resolveZCodeDataRoot(), '.zcode', 'v2', 'provider_config.json')

  const { stores, preferences } = await buildStores(args)

  let document
  try {
    document = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    // A fresh document must satisfy the same strict schema as an edited one:
    // `provider` is NOT a valid key here (it belongs to config.json's provider
    // object, a different document). Writing it produced a config ZCode
    // silently discarded in full — caught by docs/validate-provider-config.mjs.
    document = {
      schemaVersion: 1,
      config: {
        providerOrder: [],
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }
  }
  const config = document['config'] ??= {}
  const order = config['providerOrder'] ??= []
  const rules = config['providerConfigRules'] ??= {}
  const providerRules = rules['providerRules'] ??= []

  // Per-model window and output ceiling, so ZCode plans context and output
  // budget correctly instead of assuming one window for every row.
  //
  // The rule object is strict (zod `.strict()`), so ONE unrecognised key fails
  // the WHOLE document, and ZCode's failure mode is to discard the ENTIRE
  // personal provider config and fall back to an empty one -- silently breaking
  // every other provider too. The writable paths, both verified against the
  // compiled schema in `ZCode\resources\app.asar`:
  //
  //   config.properties           {contextWindow, inputFormat.{supportsImage,
  //                                supportsVideo,supportsPdf}, supportsToolCall,
  //                                supportsJsonSchemaOutput,
  //                                supportsNativeWebSearch,
  //                                supportsMidConversationSystem,
  //                                requiresMfjsToolSchema}
  //   config.optionSpecs          {reasoningLevel:{values,map},
  //                                maxOutputTokens:{max,map}}
  //
  // There is NO `maxTokens` property: an output limit lives in
  // `optionSpecs.maxOutputTokens.max`. Writing `maxTokens` into `properties`
  // is the mistake that caused the whole-document discard.
  const modelRules = (config['modelConfigRules'] ??= {})
  const providerModelRules = (modelRules['providerModelRules'] ??= [])
  modelRules['manualProviderModelRules'] ??= []

  /**
   * The widest window the upstream admits for a model: the max-mode 1M
   * profile when the preference is on and the model declares one, else the
   * dev window the descriptor publishes.
   */
  const effectiveContextWindow = model => {
    const max = model.maxContextWindow
    return preferences.useMaximumContextWindow() && typeof max === 'number' && max > model.contextWindow
      ? max
      : model.contextWindow
  }

  const summary = []
  for (const { id, path: mount, appName, providerId, store, client } of stores) {
    let models = []
    try {
      const credential = await store.resolve()
      models = await client.fetchModels(credential)
    } catch (error) {
      // No credential for this edition is a normal state (app not installed):
      // skip the provider entirely rather than register one that only fails.
      console.warn(`warning: ${appName} unavailable, skipping its provider (${String(error)})`)
      summary.push({ providerId, appName, skipped: true, reason: String(error) })
      continue
    }
    // Locked models (intl tier view) are selectable but the upstream refuses
    // to create a session for them without a paid tier — registering them
    // would only advertise failures, so they are dropped here. They stay
    // visible in `status`, which is the diagnostic surface.
    const usable = models.filter(model => model.locked !== true)

    // Ids stay exactly as the edition names them. The edition travels in the
    // baseUrl mount below, so nothing has to be encoded into the name a user
    // reads in the picker.
    const wiredIds = usable.map(model => model.id)
    const variantBaseUrl = `http://127.0.0.1:${port}${mount}/v1`

    const rule = {
      providerId,
      providerName: appName,
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: token },
        api: { type: 'openai-chat-completions', baseUrl: variantBaseUrl },
        personalModelIds: wiredIds,
        modelOrder: wiredIds,
      },
    }
    const existing = providerRules.findIndex(item => item?.providerId === providerId)
    if (existing === -1) providerRules.push(rule)
    else providerRules[existing] = rule
    if (!order.includes(providerId)) order.push(providerId)

    let modelCount = 0
    for (const model of usable) {
      modelCount += 1
      const properties = { contextWindow: effectiveContextWindow(model) }
      const modelConfig = { enabled: true, properties }
      // Ceiling on the selectable output budget, taken from the upstream's own
      // declaration rather than a per-model guess.
      if (Number.isInteger(model.maxTokens) && model.maxTokens > 0) {
        modelConfig.optionSpecs = { maxOutputTokens: { max: model.maxTokens } }
      }
      const entry = { modelId: model.id, providerId, config: modelConfig }
      const index = providerModelRules.findIndex(item => item?.modelId === entry.modelId && item?.providerId === providerId)
      if (index === -1) providerModelRules.push(entry)
      else providerModelRules[index] = entry
    }

    summary.push({
      providerId,
      appName,
      models: wiredIds.length,
      modelRules: modelCount,
      baseUrl: variantBaseUrl,
      modelIds: wiredIds,
      // Full shapes for the 3.15.3 personal-provider mirror (see
      // writePersonalProviders): the legacy document only needs ids.
      detail: usable.map(model => ({
        id: model.id,
        name: modelLabel(model),
        contextWindow: effectiveContextWindow(model),
        maxTokens: model.maxTokens,
        supportsImages: model.supportsImages === true,
      })),
    })
  }

  // Setup has to be idempotent: it only ever adds or updates, so a rule left
  // behind by an earlier run — a renamed model — would otherwise linger in
  // the picker forever. Drop every rule that belongs to a provider we manage
  // but is no longer declared by it.
  const managed = new Map(stores.map(({ providerId }) => [providerId, undefined]))
  for (const item of summary) {
    if (item.skipped !== true) managed.set(item.providerId, new Set(item.modelIds))
  }
  for (let index = providerModelRules.length - 1; index >= 0; index -= 1) {
    const declared = managed.get(providerModelRules[index]?.providerId)
    if (declared !== undefined && !declared.has(providerModelRules[index].modelId)) {
      providerModelRules.splice(index, 1)
    }
  }

  // Write through a temp file and validate before the real path is touched.
  //
  // ZCode's provider schema is `.strict()`, and its failure mode is to discard
  // the ENTIRE document and fall back to an empty config when any rule carries
  // an unrecognised key. The user's other providers (OpenRouter, DeepSeek, …)
  // would go with it, and nothing would say why. The validator mirrors the
  // schema, so a bad key fails loudly here instead of silently there.
  await mkdir(dirname(configPath), { recursive: true })
  const tempPath = `${configPath}.${process.pid}.tmp`
  const serialized = `${JSON.stringify(document, null, 2)}\n`
  await writeFile(tempPath, serialized, 'utf8')
  const verdict = await validateProviderConfig(tempPath)
  if (!verdict.ok) {
    await rm(tempPath, { force: true })
    console.error(`error: refusing to write ${configPath} — the document would be rejected by ZCode's schema:`)
    for (const problem of verdict.problems) console.error(`  - ${problem}`)
    console.error('  ZCode discards the whole provider config in that case, so nothing was written.')
    process.exitCode = 1
    return
  }
  await rename(tempPath, configPath)

  // Mirror the same providers into the second document ZCode maintains — the
  // `provider` object of config.json. The registry document above is the one
  // the picker reads; this mirror is what the app itself keeps in sync for its
  // UI-added providers (its OpenCode entries persist there too).
  const mirrored = await writePersonalProviders(port, token, summary)
  if (mirrored.error !== undefined) {
    console.warn(`warning: personal provider config not updated: ${mirrored.error}`)
  }

  if (args.json) {
    console.log(JSON.stringify({ configPath, baseUrl, providers: summary, personalConfig: mirrored }, null, 2))
    return
  }
  console.log(`Wrote provider entries into ${configPath}`)
  console.log(`  baseUrl   ${baseUrl}`)
  console.log(`  bearer    ${mask(token)}`)
  if (mirrored.path !== undefined) {
    console.log(`  personal ${mirrored.path}`)
    console.log(`            ${mirrored.providers} provider(s), ${mirrored.models} model(s) — picked up by a running app on its next config poll`)
  }
  for (const item of summary) {
    if (item.skipped) console.log(`  ${item.appName.padEnd(14)} SKIPPED — ${item.reason.slice(0, 90)}`)
    else console.log(`  ${item.appName.padEnd(14)} ${item.models} models (${item.modelRules} per-model rules) @ ${item.baseUrl}`)
  }
}

/**
 * Mirror the endpoint providers into ZCode's `config.json` provider object.
 *
 * `provider_config.json` (written by `commandSetup`) is the personal provider
 * registry the model picker reads — confirmed against the app's own writes:
 * a provider added in the UI lands in `<dataBaseDir>/.zcode/v2/
 * provider_config.json`. The `provider` object of `config.json` is a second,
 * app-maintained mirror of the same personal providers (the UI's OpenCode
 * entries persist there as well), so both documents are written and both
 * resolve under the same data root.
 *
 * The id is a fixed UUID rather than a readable slug: the ids ZCode itself
 * mints for custom providers (`crypto.randomUUID()` in the app) are UUIDs, and
 * matching that shape avoids any id-format assumption in the registry. The
 * entry is rewritten in place on every run, so re-running setup is idempotent.
 *
 * Caveat: ZCode keeps this document in memory while it runs and may persist
 * its own view over ours on exit. Run setup (or this mirror) while ZCode is
 * closed, or simply re-run it after a restart, if the providers go missing.
 */
async function writePersonalProviders(port, token, summary) {
  const configPath = join(resolveZCodeDataRoot(), '.zcode', 'v2', 'config.json')
  const live = summary.filter(item => item.skipped !== true && Array.isArray(item.detail) && item.detail.length > 0)
  if (live.length === 0) {
    return { path: configPath, providers: 0, models: 0 }
  }

  const idFor = providerId => providerId === 'trae'
    ? '3f8a1c2e-9d4b-4f6a-b5e7-1c2d3e4f5a6b'
    : '8b7c6d5e-4f3a-4b2c-9d1e-0f1a2b3c4d5e'

  let document
  try {
    document = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    document = {}
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) document = {}
  const providers = (typeof document['provider'] === 'object' && document['provider'] !== null && !Array.isArray(document['provider']))
    ? document['provider']
    : {}
  document['provider'] = providers

  let modelTotal = 0
  for (const item of live) {
    const models = {}
    for (const model of item.detail) {
      modelTotal += 1
      models[model.id] = {
        name: model.name,
        limit: {
          context: Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : 200000,
          output: Number.isInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 64000,
        },
        modalities: {
          input: model.supportsImages ? ['text', 'image'] : ['text'],
          output: ['text'],
        },
      }
    }
    providers[idFor(item.providerId)] = {
      name: item.appName,
      kind: 'openai-compatible',
      options: {
        apiKey: token,
        baseURL: item.baseUrl,
        apiKeyRequired: true,
      },
      source: 'custom',
      models,
    }
  }

  // Same temp-file-then-rename discipline as the registry write: a half-written
  // config.json would be discarded wholesale by ZCode, taking every provider
  // (including the user's own) with it.
  try {
    await mkdir(dirname(configPath), { recursive: true })
    const tempPath = `${configPath}.${process.pid}.tmp`
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(tempPath, configPath)
  } catch (error) {
    return { path: configPath, providers: 0, models: 0, error: String(error) }
  }
  return { path: configPath, providers: live.length, models: modelTotal }
}

/**
 * Run the schema mirror over a candidate document.
 *
 * Delegates to `docs/validate-provider-config.mjs` rather than reimplementing
 * the shapes: that file is the one place the schema is written down, and it is
 * also runnable by hand. A validator that disagrees with itself is worse than
 * none, so this shells out to it and reads the exit code.
 *
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
async function validateProviderConfig(candidatePath) {
  const script = fileURLToPath(new URL('../docs/validate-provider-config.mjs', import.meta.url))
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [script, candidatePath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => resolve({ ok: false, problems: [String(error)] }))
    child.on('close', code => {
      const problems = stderr.split('\n')
        .filter(line => line.trim().startsWith('- '))
        .map(line => line.trim().slice(2))
      resolve({ ok: code === 0, problems: problems.length > 0 ? problems : [stderr.trim() || `validator exited ${code}`] })
    })
  })
}

async function commandServe(args) {
  const token = await ensureToken(args)
  const port = args.port === undefined ? DEFAULT_PORT : Number(args.port)
  configureEndpoint({ port, token })
  const { stores, refreshDesktopAuths } = await buildStores(args)

  const server = createTraeServer({
    token,
    port,
    variants: stores.map(({ id, path: mount, prefix, store, catalog: _unused, client }) => ({
      id,
      path: mount,
      prefix,
      store,
      catalog: new TraeCatalog(id),
      client,
    })),
  })
  await server.start()

  const url = `http://127.0.0.1:${server.port()}`
  console.log(`[zcode-trae-connect] listening on ${url}`)
  console.log(`[zcode-trae-connect] OpenAI-compatible base: ${url}/v1`)
  for (const { id, path: mount, appName } of stores) {
    console.log(`[zcode-trae-connect]   ${appName} (${id}) mount: ${url}${mount}/v1`)
  }
  console.log(`[zcode-trae-connect] bearer: ${token}`)
  console.log(`[zcode-trae-connect] state dir: ${stateDir()}`)

  // Follow the desktop app: a re-login or token rotation in Trae must be
  // picked up without a restart. Cheap when nothing changed (one directory
  // scan per edition, registry survey cached).
  const desktopTimer = setInterval(() => { void refreshDesktopAuths() }, 30 * 1000)
  desktopTimer.unref?.()

  const shutdown = async signal => {
    console.log(`\n[zcode-trae-connect] ${signal} — shutting down`)
    clearInterval(desktopTimer)
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // Never exit on an unhandled stream error; a single failed request must not
  // take down the endpoint every model call depends on.
  process.on('uncaughtException', error => {
    console.error(`[zcode-trae-connect] uncaught: ${String(error)}`)
  })
  process.on('unhandledRejection', error => {
    console.error(`[zcode-trae-connect] unhandled rejection: ${String(error)}`)
  })
}

/** Run a command from argv. Exported so the bin entry stays a one-liner. */
export async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.h === true) {
    console.log(HELP)
    return
  }
  configureStateDir(typeof args.home === 'string' ? args.home : defaultStateDir())
  configureEndpoint({ port: Number(args.port) || 0, token: typeof args.token === 'string' ? args.token : '' })

  const command = args._[0] ?? 'serve'
  switch (command) {
    case 'serve':
      await commandServe(args)
      return
    case 'status':
      await commandStatus(args)
      return
    case 'refresh':
      await commandRefresh(args)
      return
    case 'setup':
      await commandSetup(args)
      return
    case 'doctor':
      await commandDoctor(args)
      return
    case 'logout':
      await commandLogout(args)
      return
    case 'install-service':
      await commandInstallService(args)
      return
    case 'uninstall-service':
      await commandUninstallService(args)
      return
    case 'service-status':
      await commandServiceStatus(args)
      return
    case 'token':
      console.log(await ensureToken(args))
      return
    default:
      console.error(`Unknown command: ${command}\n`)
      console.log(HELP)
      process.exitCode = 2
  }
}
