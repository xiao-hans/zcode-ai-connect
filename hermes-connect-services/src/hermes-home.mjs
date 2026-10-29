/**
 * hermes-home.mjs — the two side files a shell hook needs before it will run.
 *
 * `config.yaml` alone is not enough to make `hooks.on_session_start` fire:
 *
 *   1. shell-hooks-allowlist.json — hermes only runs a hook whose exact
 *      (event, command) pair is approved. Without it the gateway logs
 *      "not allowlisted ... — skipped" on every session and the endpoints are
 *      never started. We append the pair, keeping other hooks' approvals.
 *
 *   2. .env NO_PROXY — the OpenAI SDK underneath hermes is httpx, which honours
 *      HTTP_PROXY. A machine-wide proxy therefore swallows every 127.0.0.1 call
 *      and the provider dies with ECONNREFUSED. The loopback endpoints must be
 *      excluded from proxying.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWLIST_FILENAME = 'shell-hooks-allowlist.json';
const ENV_MARKER_START = '# >>> zcode-ai-connect >>>';
const ENV_MARKER_END = '# <<< zcode-ai-connect <<<';
const LOOPBACK = '127.0.0.1,localhost,::1,0.0.0.0';

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { approvals: [] };
  } catch {
    return { approvals: [] };
  }
}

/**
 * Approve one (event, command) pair. Idempotent: an identical pair is left
 * alone so the approved_at timestamp does not churn on every sync.
 *
 * @returns {'added' | 'present' | 'skipped-dry-run'}
 */
export function allowHook(homeDir, event, command, { dryRun = false } = {}) {
  const path = join(homeDir, ALLOWLIST_FILENAME);
  const data = readJson(path);
  const approvals = Array.isArray(data.approvals) ? data.approvals : [];
  if (approvals.some((e) => e && e.event === event && e.command === command)) return 'present';
  if (dryRun) return 'skipped-dry-run';

  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  data.approvals = [...approvals, {
    event,
    command,
    approved_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    script_mtime_at_approval: null,
  }];
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return 'added';
}

/** Drop our own approvals (used by --remove). Other hooks stay approved. */
export function revokeHooks(homeDir, commands, { dryRun = false } = {}) {
  const path = join(homeDir, ALLOWLIST_FILENAME);
  if (!existsSync(path)) return 0;
  const data = readJson(path);
  const approvals = Array.isArray(data.approvals) ? data.approvals : [];
  const kept = approvals.filter((e) => !(e && commands.includes(e.command)));
  const removed = approvals.length - kept.length;
  if (removed === 0 || dryRun) return removed;
  copyFileSync(path, `${path}.bak`);
  data.approvals = kept;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return removed;
}

/**
 * Make sure the loopback hosts bypass the machine proxy. The managed block is
 * rewritten in place so repeated runs stay byte-stable.
 *
 * @returns {'wrote' | 'updated' | 'present' | 'skipped-dry-run'}
 */
export function ensureNoProxy(homeDir, { dryRun = false } = {}) {
  const path = join(homeDir, '.env');
  const body = [
    ENV_MARKER_START,
    `NO_PROXY=${LOOPBACK}`,
    `no_proxy=${LOOPBACK}`,
    ENV_MARKER_END,
  ].join('\n');

  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const start = text.indexOf(ENV_MARKER_START);
  const end = text.indexOf(ENV_MARKER_END);

  if (start !== -1 && end !== -1 && end > start) {
    const current = text.slice(start, end + ENV_MARKER_END.length);
    if (current === body) return 'present';
    if (dryRun) return 'skipped-dry-run';
    copyFileSync(path, `${path}.bak`);
    writeFileSync(path, text.slice(0, start) + body + text.slice(end + ENV_MARKER_END.length), 'utf8');
    return 'updated';
  }

  if (dryRun) return 'skipped-dry-run';
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const prefix = text === '' ? '' : (text.endsWith('\n') ? '\n' : '\n\n');
  writeFileSync(path, `${text}${prefix}${body}\n`, 'utf8');
  return 'wrote';
}

/** Remove the managed NO_PROXY block (used by --remove). */
export function removeNoProxy(homeDir, { dryRun = false } = {}) {
  const path = join(homeDir, '.env');
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf(ENV_MARKER_START);
  const end = text.indexOf(ENV_MARKER_END);
  if (start === -1 || end === -1) return false;
  if (dryRun) return true;
  copyFileSync(path, `${path}.bak`);
  const before = text.slice(0, start).replace(/\n+$/, '\n');
  const after = text.slice(end + ENV_MARKER_END.length).replace(/^\n+/, '');
  writeFileSync(path, `${before}${after}`, 'utf8');
  return true;
}
