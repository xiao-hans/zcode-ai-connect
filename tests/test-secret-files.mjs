// endpoint.json / pat.txt are bearer material. serve must not echo the bearer.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { savePat } from '../zcode-qoder-connect/src/credentials.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = await mkdtemp(path.join(tmpdir(), 'secret-files-'))
const children = []

after(async () => {
  for (const child of children) if (!child.killed) child.kill('SIGKILL')
  await rm(home, { recursive: true, force: true })
})

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

function privateEnv(extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ZCODE_QODER_CONNECT_HOME: path.join(home, '.zcode-qoder-connect'),
    ...extra,
  }
}

test('Qoder savePat and endpoint.json are mode 0600', () => {
  const dir = path.join(home, 'pat-dir')
  spawnSync('mkdir', ['-p', dir])
  savePat(dir, 'pat-secret-value')
  const patFile = path.join(dir, 'pat.txt')
  assert.equal(readFileSync(patFile, 'utf8'), 'pat-secret-value')
  assert.equal(statSync(patFile).mode & 0o777, 0o600)

  const result = spawnSync(process.execPath, [path.join(root, 'zcode-qoder-connect', 'bin', 'cli.mjs'), 'service-status'], {
    env: privateEnv(),
    encoding: 'utf8',
  })
  assert.equal(result.status ?? 0, 0, result.stderr)
  const endpoint = path.join(home, '.zcode-qoder-connect', 'endpoint.json')
  const document = JSON.parse(readFileSync(endpoint, 'utf8'))
  assert.equal(typeof document.token, 'string')
  assert.equal(document.token.length > 10, true)
  assert.equal(statSync(endpoint).mode & 0o777, 0o600)
  assert.equal(`${result.stdout}${result.stderr}`.includes(document.token), false)
})

test('QwenWork endpoint.json is mode 0600', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'zcode-qwenwork-connect', 'bin', 'cli.mjs'), 'service-status'], {
    env: privateEnv(),
    encoding: 'utf8',
  })
  assert.equal(result.status ?? 0, 0, result.stderr)
  const endpoint = path.join(home, '.zcode-qwenwork-connect', 'endpoint.json')
  const document = JSON.parse(readFileSync(endpoint, 'utf8'))
  assert.equal(statSync(endpoint).mode & 0o777, 0o600)
  assert.equal(`${result.stdout}${result.stderr}`.includes(document.token), false)
})

async function assertServeHidesBearer(script, endpointFile) {
  const port = await freePort()
  let output = ''
  const child = spawn(process.execPath, [script, 'serve', '--port', String(port)], {
    env: privateEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const deadline = Date.now() + 15000
  while (!output.includes('bearer:') && Date.now() < deadline) {
    if (child.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  child.kill('SIGKILL')
  const document = JSON.parse(readFileSync(endpointFile, 'utf8'))
  assert.match(output, /bearer:/, output)
  assert.equal(output.includes(document.token), false, output)
}

test('Qoder serve does not print the full bearer', async () => {
  await assertServeHidesBearer(
    path.join(root, 'zcode-qoder-connect', 'bin', 'cli.mjs'),
    path.join(home, '.zcode-qoder-connect', 'endpoint.json'),
  )
})

test('QwenWork serve does not print the full bearer', async () => {
  await assertServeHidesBearer(
    path.join(root, 'zcode-qwenwork-connect', 'bin', 'cli.mjs'),
    path.join(home, '.zcode-qwenwork-connect', 'endpoint.json'),
  )
})

test('Trae and WorkBuddy serve logs mask the bearer', () => {
  for (const file of ['zcode-trae-connect/src/cli.js', 'zcode-workbuddy-connect/src/cli.js']) {
    const source = readFileSync(path.join(root, file), 'utf8')
    assert.equal(source.includes('bearer: ${mask(token)}'), true, file)
    assert.equal(source.includes('bearer: ${token}'), false, file)
  }
})
