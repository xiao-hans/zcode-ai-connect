// The bridge injects downstream bearers. A local process that does not know
// ~/.zcode-codex-bridge/auth.json must not be able to spend them.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { settingsForLaunch } from '../scripts/claude-connect-launch.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const bridge = path.join(root, 'scripts', 'codex-responses-bridge.mjs')
const home = await mkdtemp(path.join(tmpdir(), 'bridge-auth-'))
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex') }
let child

after(async () => {
  if (child && !child.killed) child.kill('SIGKILL')
  await rm(home, { recursive: true, force: true })
})

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, args, { env: { ...env, ...extraEnv }, encoding: 'utf8' })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

test('bridge token is created once, mode 0600, and is not wrapped in extra logs', () => {
  const first = run([bridge, 'token'])
  assert.equal(first.status, 0, first.stderr)
  const token = first.stdout.trim()
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/)
  assert.equal(first.stdout, `${token}\n`)
  const file = path.join(home, '.zcode-codex-bridge', 'auth.json')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, token)
  const second = run([bridge, 'token'])
  assert.equal(second.stdout.trim(), token)
})

test('serve requires the bridge bearer and leaves health probes open', async () => {
  const token = JSON.parse(readFileSync(path.join(home, '.zcode-codex-bridge', 'auth.json'), 'utf8')).token
  const port = await freePort()
  let output = ''
  child = spawn(process.execPath, [bridge, 'serve', '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 8000
  let health
  while (Date.now() < deadline) {
    try {
      health = await fetch(`${base}/healthz`)
      if (health.ok) break
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(health?.status, 200)
  const healthBody = await health.text()
  assert.equal(healthBody.includes(token), false)

  const denied = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(denied.status, 401)
  assert.equal((await denied.text()).includes(token), false)

  const wrong = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-bridge-token' },
    body: JSON.stringify({ model: 'wb/test', input: 'hi' }),
  })
  assert.equal(wrong.status, 401)

  const accepted = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': token },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(accepted.status, 200)

  const hosted = await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { host: 'evil.example', 'content-type': 'application/json', authorization: `Bearer ${token}` },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(hosted, 403)
  assert.equal(output.includes(token), false)
  child.kill('SIGKILL')
  child = undefined
})

test('setup-codex writes the bridge bearer for Codex and does not print it', () => {
  const token = JSON.parse(readFileSync(path.join(home, '.zcode-codex-bridge', 'auth.json'), 'utf8')).token
  const result = run([path.join(root, 'scripts', 'setup-codex.mjs')])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.includes(token), false)
  assert.equal(result.stderr.includes(token), false)
  const configPath = path.join(env.CODEX_HOME, 'config.toml')
  const config = readFileSync(configPath, 'utf8')
  assert.match(config, new RegExp(`experimental_bearer_token = "${token}"`))
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:39268\/v1"/)
  assert.equal(statSync(configPath).mode & 0o777, 0o600)
})

test('claude launcher injects the bridge bearer without rewriting the saved settings', () => {
  const original = JSON.parse(readFileSync(path.join(root, 'scripts', 'claude-connect-settings.json'), 'utf8'))
  const launched = settingsForLaunch(original, 'bridge-token-value')
  assert.equal(launched.env.ANTHROPIC_AUTH_TOKEN, 'bridge-token-value')
  assert.equal(original.env.ANTHROPIC_AUTH_TOKEN, 'zc-connect-local')
  assert.equal(launched.env.ANTHROPIC_BASE_URL, original.env.ANTHROPIC_BASE_URL)
  assert.deepEqual(launched.hooks, original.hooks)

  const token = JSON.parse(readFileSync(path.join(home, '.zcode-codex-bridge', 'auth.json'), 'utf8')).token
  const bin = mkdtempSync(path.join(home, 'bin-'))
  const capture = path.join(home, 'claude-capture.json')
  const fake = path.join(bin, 'claude')
  writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
const file = process.argv[process.argv.indexOf('--settings') + 1];
writeFileSync(process.env.CAPTURE, JSON.stringify({
  mode: statSync(file).mode & 0o777,
  settings: JSON.parse(readFileSync(file, 'utf8')),
}));
`)
  chmodSync(fake, 0o755)
  const result = run([path.join(root, 'scripts', 'claude-connect-launch.mjs'), '-p', 'ping'], {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    CAPTURE: capture,
  })
  assert.equal(result.status, 0, result.stderr)
  const captured = JSON.parse(readFileSync(capture, 'utf8'))
  assert.equal(captured.mode, 0o600)
  assert.equal(captured.settings.env.ANTHROPIC_AUTH_TOKEN, token)
  assert.equal(captured.settings.env.ANTHROPIC_BASE_URL, original.env.ANTHROPIC_BASE_URL)
  assert.deepEqual(captured.settings.hooks, original.hooks)
  assert.equal(JSON.parse(readFileSync(path.join(root, 'scripts', 'claude-connect-settings.json'), 'utf8')).env.ANTHROPIC_AUTH_TOKEN, 'zc-connect-local')

  const emitted = run([path.join(root, 'scripts', 'claude-connect-launch.mjs'), '--emit-settings'])
  assert.equal(emitted.status, 0, emitted.stderr)
  const emittedPath = emitted.stdout.trim()
  assert.equal(statSync(emittedPath).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(emittedPath, 'utf8')).env.ANTHROPIC_AUTH_TOKEN, token)
  rmSync(emittedPath)
})
