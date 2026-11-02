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
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const region = managedEnvRegion(text);
  const unmanaged = region ? text.slice(0, region.start) + text.slice(region.end) : text;
  // Let python-dotenv resolve effective values (quotes, comments, duplicates and
  // interpolation). Put this last, and never feed a previous managed value back in.
  const body = [
    ENV_MARKER_START,
    `NO_PROXY="\${NO_PROXY},\${no_proxy},${LOOPBACK}"`,
    'no_proxy="${NO_PROXY}"',
    ENV_MARKER_END,
    '',
  ].join('\n');
  const separator = unmanaged === '' || unmanaged.endsWith('\n') ? '' : '\n';
  const next = `${unmanaged}${separator}${body}`;
  if (next === text) return 'present';
  if (dryRun) return 'skipped-dry-run';
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, next, 'utf8');
  return region ? 'updated' : 'wrote';
}

/** Remove the managed NO_PROXY block (used by --remove). */
export function removeNoProxy(homeDir, { dryRun = false } = {}) {
  const path = join(homeDir, '.env');
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  const region = managedEnvRegion(text);
  if (!region) return false;
  if (dryRun) return true;
  copyFileSync(path, `${path}.bak`);
  writeFileSync(path, text.slice(0, region.start) + text.slice(region.end), 'utf8');
  return true;
}

function managedEnvRegion(text) {
  const start = new RegExp(`^${ENV_MARKER_START}\\r?$`, 'm').exec(text);
  if (!start) return null;
  const tail = text.slice(start.index + start[0].length);
  const end = new RegExp(`^${ENV_MARKER_END}(?:\\r?\\n|$)`, 'm').exec(tail);
  if (!end) return null;
  return { start: start.index, end: start.index + start[0].length + end.index + end[0].length };
}
