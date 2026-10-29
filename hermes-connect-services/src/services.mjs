/**
 * The four loopback endpoints this suite serves, described once so the ensure
 * script and the config sync agree on ports, state dirs and provider ids.
 *
 * Provider ids are prefixed with `zc-` so they can never collide with a
 * hermes built-in (openrouter / nous / gemini / …) or with a provider the user
 * already declared by hand. Everything else about the entry is derived at sync
 * time from the live endpoint, which is the only source of truth for the
 * roster and the bearer token.
 *
 * @module hermes-connect-services/src/services
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdir, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Suite root = the directory the sibling tools live in.
 *
 * In a git checkout that is the repo root; in an npm install the module sits
 * at `<proj>/node_modules/hermes-connect-services/src/`, so one level up from
 * `node_modules` is what we want — otherwise every path would gain a second
 * `node_modules`.
 */
const PACKAGE_PARENT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const SUITE_ROOT = resolve(
  process.env.AI_CONNECT_SUITE_ROOT
  ?? (basename(PACKAGE_PARENT) === 'node_modules' ? dirname(PACKAGE_PARENT) : PACKAGE_PARENT),
);

export const SERVICES = [
  {
    id: 'zc-qwenwork',
    name: '千问办公 (QwenWork)',
    tool: 'zcode-qwenwork-connect',
    port: 39269,
    state: '.zcode-qwenwork-connect',
  },
  {
    id: 'zc-qoder',
    name: 'Qoder CN',
    tool: 'zcode-qoder-connect',
    port: 39270,
    state: '.zcode-qoder-connect',
  },
  {
    id: 'zc-workbuddy',
    name: 'WorkBuddy',
    tool: 'zcode-workbuddy-connect',
    port: 39271,
    state: '.zcode-workbuddy-connect',
  },
  {
    id: 'zc-trae',
    name: 'Trae CN',
    tool: 'zcode-trae-connect',
    port: 39272,
    state: '.zcode-trae-connect',
  },
];

export const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '.';

const toolDirCache = new Map();

/**
 * Where a sibling tool actually lives.
 *
 * Three layouts have to work, because this module ships both as a git checkout
 * and as an npm package:
 *
 *   <repo>/hermes-connect-services/ + <repo>/zcode-trae-connect/   (checkout)
 *   <proj>/node_modules/zcode-trae-connect/                        (npm install)
 *   <prefix>/node_modules/zcode-trae-connect/                      (npm -g)
 *
 * `AI_CONNECT_SUITE_ROOT` wins when set, which is the escape hatch for any
 * layout not covered above.
 */
export function toolDir(service) {
  const cached = toolDirCache.get(service.id);
  if (cached) return cached;

  const candidates = [
    process.env.AI_CONNECT_SUITE_ROOT ? join(process.env.AI_CONNECT_SUITE_ROOT, service.tool) : null,
    join(SUITE_ROOT, service.tool),
    join(SUITE_ROOT, 'node_modules', service.tool),
    join(dirname(SUITE_ROOT), service.tool),
  ].filter(Boolean);

  const resolved = candidates.find((dir) => existsSync(join(dir, 'bin', 'cli.mjs'))) ?? candidates[1];
  toolDirCache.set(service.id, resolved);
  return resolved;
}

export const cliPath = (service) => join(toolDir(service), 'bin', 'cli.mjs');
export const toolRoot = (service) => toolDir(service);
export const stateDir = (service) => join(HOME, service.state);

/** Read `{token, port}` from the tool's state dir, falling back to its default port. */
export async function readEndpoint(service) {
  try {
    const document = JSON.parse(await readFile(join(stateDir(service), 'endpoint.json'), 'utf8'));
    const token = typeof document.token === 'string' ? document.token : '';
    const port = Number.isInteger(document.port) && document.port > 0 ? document.port : service.port;
    return { token, port };
  } catch {
    return { token: '', port: service.port };
  }
}

/** True only when the endpoint answers healthily — the same contract as every plugin's hook. */
export async function healthy(port, token, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: token === '' ? {} : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealth(port, token, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (await healthy(port, token)) return true;
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

/**
 * Detached, windowless, best-effort start.
 *
 * `windowsHide` plus `stdio: 'ignore'` matters: a session-start hook that
 * flashes four console windows would be worse than no hook at all.
 */
function spawnDetached(service, port) {
  const child = spawn(process.execPath, [cliPath(service), 'serve', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: toolRoot(service),
  });
  child.unref();
  return child.pid;
}

/**
 * Ensure one endpoint is up. Never throws — the session must go on even when
 * the host refuses to spawn.
 *
 * @returns {{ service: object, port: number, token: string, up: boolean, action: string, pid?: number }}
 */
export async function ensure(service) {
  const { token, port } = await readEndpoint(service);
  const base = { service, port, token };

  if (!existsSync(cliPath(service))) {
    return { ...base, up: false, action: `not installed (missing ${cliPath(service)})` };
  }
  if (await healthy(port, token)) {
    return { ...base, up: true, action: 'already up' };
  }

  let pid;
  try {
    pid = spawnDetached(service, port);
  } catch (error) {
    return { ...base, up: false, action: `spawn refused: ${String(error).slice(0, 80)}` };
  }
  if (await waitForHealth(port, token)) {
    return { ...base, up: true, action: 'started', pid };
  }
  return { ...base, up: false, action: `did not become healthy on :${port}`, pid };
}

/** Best-effort transcript for hook debugging; never allowed to throw. */
export async function log(service, line) {
  try {
    await mkdir(stateDir(service), { recursive: true });
    await appendFile(join(stateDir(service), 'service.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Diagnostics are optional.
  }
}
