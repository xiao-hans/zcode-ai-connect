/**
 * State layout for the QwenWork endpoint.
 *
 * `endpoint.json` holds the loopback bearer token and the fixed port so the
 * ZCode provider registration (which persists an apiKey) keeps working across
 * restarts — same contract as the trae/workbuddy/qoder tools in this suite.
 *
 * @module zcode-qwenwork-connect/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_PORT = 39269

export function defaultStateDir() {
  return join(process.env['USERPROFILE'] ?? homedir(), '.zcode-qwenwork-connect')
}

let current = { stateDir: defaultStateDir(), port: DEFAULT_PORT, token: '' }

export function configureStateDir(dir) {
  current.stateDir = dir
}

export function configureEndpoint({ port, token }) {
  if (Number.isFinite(port) && port > 0) current.port = port
  if (typeof token === 'string' && token !== '') current.token = token
}

export function stateDir() {
  return current.stateDir
}

export function endpointPath() {
  return join(current.stateDir, 'endpoint.json')
}
