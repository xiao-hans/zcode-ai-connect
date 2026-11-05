// VPC TLS relaxation must not turn verification off for the whole process.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const temp = await mkdtemp(path.join(tmpdir(), 'qwen-tls-'))
for (const key of ['TMP', 'TEMP', 'TMPDIR']) process.env[key] = temp
const certDir = temp
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(certDir, 'key.pem'),
  '-out', path.join(certDir, 'cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=localhost',
], { stdio: 'ignore' })

const { relaxTlsForVpc, fetchWithoutTlsVerify } = await import('../zcode-qwenwork-connect/vendor/lib/endpoint.js')
const { startChatShim } = await import('../zcode-qwenwork-connect/vendor/lib/chat-shim.js')

let tls
let httpHits = 0
const closers = []

after(async () => {
  for (const close of closers) await close()
  if (tls) await new Promise((resolve) => tls.close(resolve))
  await rm(temp, { recursive: true, force: true })
})

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

test('relaxTlsForVpc keeps process TLS verification and only swaps the VPC fetch', () => {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const vpc = relaxTlsForVpc('https://tenant.vpc.qwenwork.cn')
  const pub = relaxTlsForVpc('https://gateway.qwenwork.cn')
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before)
  assert.equal(pub, globalThis.fetch)
  assert.equal(vpc, fetchWithoutTlsVerify)
})

test('a VPC chat uses the scoped fetch; other fetches still reject the same certificate', async () => {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  tls = createServer({
    key: readFileSync(path.join(certDir, 'key.pem')),
    cert: readFileSync(path.join(certDir, 'cert.pem')),
  }, (req, res) => {
    httpHits += 1
    res.writeHead(418, { 'content-type': 'text/plain' })
    res.end('vpc-reached')
  })
  await new Promise((resolve) => tls.listen(0, '127.0.0.1', resolve))
  const tlsPort = tls.address().port
  const upstreamUrl = `https://127.0.0.1:${tlsPort}/up`
  const logger = { warn() {}, error() {}, info() {} }
  const signerFactory = () => Promise.resolve({
    signInferRequest() {
      return { url: upstreamUrl, headers: { 'content-type': 'application/json' }, body: '{}' }
    },
  })
  const body = { model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'hi' }] }

  const vpc = await startChatShim({
    endpoint: 'https://tenant.vpc.qwenwork.cn',
    sharedSecret: 'shim-secret',
    getHeaderTimeoutMs: 3000,
    logger,
    signerFactory,
    getCredential: async () => ({ token: 'credential' }),
  })
  closers.push(vpc.close)
  const reached = await post(vpc.baseUrl, { authorization: 'Bearer shim-secret' }, body)
  assert.equal(reached.status, 418, reached.body)
  assert.match(reached.body, /vpc-reached/)
  assert.equal(httpHits, 1)
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before)

  await assert.rejects(fetch(upstreamUrl))
  assert.equal(httpHits, 1)
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before)

  const pub = await startChatShim({
    endpoint: 'https://gateway.qwenwork.cn',
    sharedSecret: 'shim-secret',
    getHeaderTimeoutMs: 3000,
    logger,
    signerFactory,
    getCredential: async () => ({ token: 'credential' }),
  })
  closers.push(pub.close)
  const rejected = await post(pub.baseUrl, { authorization: 'Bearer shim-secret' }, body)
  assert.equal(rejected.status, 502, rejected.body)
  assert.equal(rejected.body.includes('vpc-reached'), false)
  assert.equal(httpHits, 1)
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before)
})
