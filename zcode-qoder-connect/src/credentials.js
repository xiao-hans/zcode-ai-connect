// credentials.js — Qoder credential handling for zcode-qoder-connect.
//
// Two tracks, tried in order:
//   1. PAT  — a personal access token pasted by the human into
//             %USERPROFILE%\.zcode-qoder-connect\pat.txt (generated at
//             qoder.cn → 账号设置 → 个人访问令牌). Exchanged at
//             POST {openapi}/api/v1/jobToken/exchange {personal_token}.
//   2. Desktop — Qoder CN's own sign-in vault, reused read-only:
//             %APPDATA%/com.qodercn.app.stable/Local State
//               └─ os_crypt.encrypted_key ("DPAPI" prefix + blob)
//                  → DPAPI Unprotect (powershell System.Security) → AES key
//             %APPDATA%/com.qodercn.app.stable/auth.v1.dat
//               └─ "v10" + nonce[12] + AES-256-GCM(ct + tag[16])
//                  → { token:"dt-…", refreshToken:"drt-…", expiresAt, user }
//             dt- → POST {openapi}/api/v1/me/jobToken {clientId} → jt-.
//             When dt- is expired the fix is opening the Qoder desktop app
//             once (it refreshes the vault); the drt- refresh endpoint is not
//             public and was not reverse-engineered.
//
// Both tracks converge on a job token ("jt-") + userID; COSY-signed gateway
// calls (models/chat) carry them. Cached for 10 minutes.

import { createDecipheriv } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Qoder CN desktop data directory. */
export function qoderDataDir() {
  const fromEnv = process.env['QODER_DATA_DIR']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'com.qodercn.app.stable')
}

export const OPENAPI_BASE = 'https://openapi.qoder.com.cn'
const JOB_TOKEN_CLIENT_ID = '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa'
const CACHE_TTL_MS = 10 * 60 * 1000

export const SIGN_IN_HINT =
  '两条路任选:1) 打开 https://qoder.cn/account/integrations 生成个人访问令牌,运行 `node bin/cli.mjs login <PAT>`;2) 打开一次 Qoder CN 桌面程序让它刷新登录态(auth.v1.dat 的 dt- 已过期时必须这样做)'

export function patPath(stateDir) {
  return join(stateDir, 'pat.txt')
}

/** DPAPI-unprotect the Chromium master key via PowerShell. */
function deriveMasterKey(dataDir) {
  const state = JSON.parse(readFileSync(join(dataDir, 'Local State'), 'utf8'))
  const blob = Buffer.from(state.os_crypt.encrypted_key, 'base64')
  if (blob.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Local State encrypted_key 不是 DPAPI 格式')
  const b64 = blob.subarray(5).toString('base64')
  const ps = "Add-Type -AssemblyName System.Security;[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('" + b64 + "'),$null,'CurrentUser'))"
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
  const key = Buffer.from(out, 'base64')
  if (key.length !== 32) throw new Error('DPAPI 解出的主密钥长度异常: ' + key.length)
  return key
}

/** AES-256-GCM decrypt of auth.v1.dat (v10 + nonce[12] + ct + tag[16]). */
export function decryptAuthVault(masterKey, authPath) {
  const buf = readFileSync(authPath)
  if (!(buf[0] === 0x76 && buf[1] === 0x31 && buf[2] === 0x30)) {
    throw new Error(`auth.v1.dat 魔数异常:${buf.subarray(0, 3).toString('hex')}(期望 v10)`)
  }
  const decipher = createDecipheriv('aes-256-gcm', masterKey, buf.subarray(3, 15))
  decipher.setAuthTag(buf.subarray(buf.length - 16))
  const plaintext = Buffer.concat([decipher.update(buf.subarray(15, buf.length - 16)), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}

async function openApiJson(url, { method, token, body } = {}) {
  const response = await fetch(url, {
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  if (!response.ok) {
    const err = new Error(`qoder openapi [${response.status}]: ${text.slice(0, 200)}`)
    err.status = response.status
    throw err
  }
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error('qoder openapi: 非 JSON 响应') }
  if (payload && typeof payload === 'object' && 'code' in payload && payload.code !== 0 && payload.code !== '0') {
    const err = new Error(`qoder openapi code ${payload.code}: ${String(payload.message ?? payload.msg ?? '').slice(0, 160)}`)
    err.status = 401
    throw err
  }
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
}

/** PAT → job token via the documented exchange. */
export async function exchangePat(pat) {
  return await openApiJson(`${OPENAPI_BASE}/api/v1/jobToken/exchange`, { body: { personal_token: pat } })
}

/** dt- → job token via the desktop client id. */
export async function exchangeJobToken(dtToken) {
  return await openApiJson(`${OPENAPI_BASE}/api/v1/me/jobToken`, {
    token: dtToken,
    body: { clientId: JOB_TOKEN_CLIENT_ID },
  })
}

/** jt- → {id, email, name}. */
async function fetchUserInfo(jobToken) {
  const info = await openApiJson(`${OPENAPI_BASE}/api/v1/userinfo`, { token: jobToken })
  if (!info?.id) throw new Error('qoder userinfo 未返回用户 id')
  return { userID: info.id, email: info.email ?? '', name: info.name ?? info.username ?? 'Qoder User' }
}

export function readMachineId(dataDir = qoderDataDir()) {
  try { return readFileSync(join(dataDir, 'auth.machine-id'), 'utf8').trim() } catch { return '' }
}

/** The vault stores expiresAt as either epoch-ms or an ISO string. */
function dtExpiresAtMs(auth) {
  const v = auth?.expiresAt
  if (typeof v === 'number') return v
  if (typeof v === 'string') { const p = Date.parse(v); return Number.isNaN(p) ? 0 : p }
  return 0
}

export class QoderCredentialStore {
  constructor({ stateDir, dataDir } = {}) {
    this.stateDir = stateDir
    this.dataDir = dataDir ?? qoderDataDir()
    this.cache = null
  }

  /** Which tracks are configured, without contacting the network. */
  status() {
    const pat = existsSync(patPath(this.stateDir))
    const vault = existsSync(join(this.dataDir, 'auth.v1.dat'))
    let dtFresh = false
    if (vault) {
      try {
        const masterKey = deriveMasterKey(this.dataDir)
        const auth = decryptAuthVault(masterKey, join(this.dataDir, 'auth.v1.dat'))
        dtFresh = dtExpiresAtMs(auth) > Date.now()
      } catch {}
    }
    return { patConfigured: pat, desktopVault: vault, desktopTokenFresh: dtFresh }
  }

  async resolve() {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.credential
    let jobToken = null
    let source = ''
    const patFile = patPath(this.stateDir)
    if (existsSync(patFile)) {
      const pat = readFileSync(patFile, 'utf8').trim()
      if (pat) {
        const data = await exchangePat(pat)
        if (data?.token) { jobToken = data.token; source = 'pat' }
      }
    }
    if (!jobToken && existsSync(join(this.dataDir, 'auth.v1.dat'))) {
      const masterKey = deriveMasterKey(this.dataDir)
      const auth = decryptAuthVault(masterKey, join(this.dataDir, 'auth.v1.dat'))
      if (!(dtExpiresAtMs(auth) > Date.now())) throw new Error(`Qoder 桌面 dt- 令牌已过期(${new Date(dtExpiresAtMs(auth)).toISOString()})。${SIGN_IN_HINT}`)
      const data = await exchangeJobToken(auth.token)
      if (data?.token) { jobToken = data.token; source = 'desktop' }
    }
    if (!jobToken) throw new Error(`没有任何可用的 Qoder 凭据。${SIGN_IN_HINT}`)
    const info = await fetchUserInfo(jobToken)
    const credential = {
      userID: info.userID,
      authToken: jobToken,
      name: info.name,
      email: info.email,
      machineID: readMachineId(this.dataDir) || '00000000-0000-0000-0000-000000000000',
      source,
    }
    this.cache = { credential, expiresAt: Date.now() + CACHE_TTL_MS }
    return credential
  }
}
