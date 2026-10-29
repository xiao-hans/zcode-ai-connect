#!/usr/bin/env node
/**
 * sync-hermes-config.mjs — publish the four loopback endpoints into hermes'
 * config.yaml as OpenAI-compatible custom providers.
 *
 * Writes exactly three managed regions and touches nothing else:
 *
 *   providers.<id>       — base_url / bearer token / model allowlist
 *   model_overrides.<id> — context window, tools, vision, reasoning
 *   hooks.on_session_start (optional, `--install-hooks`) — lazy-start script
 *
 * Everything outside those marker comments (vm blocks, platform tokens,
 * MQTT chat settings, hand-written providers) survives untouched — the file is
 * patched as text, never re-serialised from a parsed tree.
 *
 * A backup of the pre-run file lands next to it as `<name>.bak`.
 *
 * Usage:
 *   node sync-hermes-config.mjs [--dry-run] [--ensure] [--install-hooks]
 *                               [--remove] [--only <zc-id>] [--config <path>]
 *                               [--no-reasoning] [--verbose]
 */

import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname as pathDirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES, HOME, SUITE_ROOT, ensure as ensureService } from '../src/services.mjs';
import { loadRoster, describe } from '../src/roster.mjs';
import { patchManagedBlock, readManagedBlock, readManagedChildren } from '../src/yaml-patch.mjs';
import { allowHook, revokeHooks, ensureNoProxy, removeNoProxy } from '../src/hermes-home.mjs';

const HERE = pathDirname(fileURLToPath(import.meta.url));
const MARKER = 'zcode-ai-connect';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

const options = {
  dryRun: flag('--dry-run') || flag('-n'),
  ensure: flag('--ensure'),
  installHooks: flag('--install-hooks'),
  remove: flag('--remove'),
  noReasoning: flag('--no-reasoning'),
  verbose: flag('--verbose') || flag('-v'),
  only: value('--only'),
  config: value('--config'),
};

/** hermes keeps its user config in %LOCALAPPDATA%/hermes on Windows, ~/.hermes elsewhere. */
function locateConfig() {
  if (options.config) return options.config;
  const candidates = [
    process.env.HERMES_HOME ? join(process.env.HERMES_HOME, 'config.yaml') : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hermes', 'config.yaml') : null,
    join(HOME, '.hermes', 'config.yaml'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];
}

const CONFIG_PATH = locateConfig();

/**
 * True when the file already binds an `on_session_start` hook outside our
 * managed region — i.e. one the user wrote, which we must not displace.
 */
function ownsHookSlot(text) {
  const lines = text.split(/\r?\n/);
  const key = lines.findIndex((line) => /^hooks\s*:\s*(#.*)?$/.test(line));
  if (key === -1) return false;
  let end = lines.length;
  for (let i = key + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') {
      end = i;
      break;
    }
  }
  return lines.slice(key + 1, end).some((line) => /^\s+on_session_start\s*:/.test(line));
}

/** YAML double-quoted scalar — safe for ids containing `#`, `:` or leading dashes. */
const q = (input) => `"${String(input).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * One provider entry. `discover_models: false` is deliberate: the allowlist is
 * written from the live roster at sync time, so hermes never has to probe a
 * stopped sidecar to render its picker.
 */
function providerBlockYaml(service, roster, models) {
  const lines = [
    `${service.id}:`,
    `  name: ${q(service.name)}`,
    `  base_url: ${q(roster.baseUrl)}`,
    `  api_mode: "chat_completions"`,
    `  api_key: ${q(roster.token)}`,
    `  discover_models: false`,
    // Long thinking bursts are normal on these models; the default request
    // timeout would abort a legitimate 90s queue wait.
    `  request_timeout_seconds: 600`,
    `  models:`,
  ];
  for (const model of models) lines.push(`    ${q(model.id)}: {}`);
  return lines;
}

function overridesBlockYaml(service, models) {
  if (models.length === 0) return null;
  const lines = [`${service.id}:`];
  for (const model of models) {
    lines.push(`  ${q(model.id)}:`);
    if (model.contextWindow) lines.push(`    context_window: ${model.contextWindow}`);
    lines.push(`    supports_tools: true`);
    lines.push(`    supports_reasoning: ${options.noReasoning ? 'false' : String(model.supportsReasoning)}`);
    lines.push(`    supports_vision: ${String(model.supportsVision)}`);
  }
  return lines;
}

function hooksBlockYaml() {
  const nodeExe = process.execPath.replaceAll('\\', '/');
  const script = join(HERE, 'ensure-services.mjs').replaceAll('\\', '/');
  // The raw string hermes shlex-splits into argv; also the key it matches
  // against shell-hooks-allowlist.json, so the two must stay byte-identical.
  const command = `"${nodeExe}" "${script}"`;
  // shlex.split + shell=False: the token that reaches Popen must keep both
  // paths quoted, so the whole value is single-quoted YAML rather than two
  // adjacent double-quoted scalars (which YAML rejects outright).
  return {
    command,
    lines: [
      `on_session_start:`,
      `  - command: '${command}'`,
      `    timeout: 30`,
    ],
  };
}

// --- collect rosters --------------------------------------------------------

const targets = options.only
  ? SERVICES.filter((s) => s.id === options.only || s.tool === options.only)
  : SERVICES;
if (targets.length === 0) {
  console.error(`[sync-hermes] unknown --only target: ${options.only}`);
  console.error(`  known ids: ${SERVICES.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

const collected = [];
for (const service of targets) {
  if (options.ensure) {
    const started = await ensureService(service);
    if (options.verbose) {
      console.log(`  ${service.id.padEnd(13)} :${started.port}  ${started.up ? 'up  ' : 'DOWN'}  ${started.action}`);
    }
  }
  try {
    const roster = await loadRoster(service);
    const models = roster.rows.map((row) => describe(row, { assumeReasoning: !options.noReasoning }));
    collected.push({ service, roster, models });
  } catch (error) {
    console.log(`  ${service.id.padEnd(13)} skipped — ${String(error.message ?? error).slice(0, 90)}`);
  }
}

if (collected.length === 0) {
  console.error(`[sync-hermes] no endpoint answered; nothing written to ${CONFIG_PATH}`);
  console.error(`  Start them first, or re-run with --ensure.`);
  process.exit(1);
}

// --- patch ------------------------------------------------------------------

/**
 * Rebuild one region, keeping the blocks this run did not touch.
 *
 * `--only zc-trae` must not delete the other three providers, so existing
 * children are read back first and only the targeted ids are overwritten.
 */
function mergeInto(originalText, key, updates) {
  const existing = new Map(readManagedChildren(originalText, key, { marker: MARKER }).map((b) => [b.key, b.body]));
  const touched = new Set();
  for (const [childKey, body] of updates) {
    existing.set(childKey, body);
    touched.add(childKey);
  }
  return {
    body: [...existing.values()].join('\n'),
    action: touched.size < updates.length ? 'partial' : null,
  };
}

const original = readFileSync(CONFIG_PATH, 'utf8');
let text = original;

if (options.remove) {
  for (const key of ['providers', 'model_overrides', 'hooks']) {
    const result = patchManagedBlock(text, key, '', { marker: MARKER });
    text = result.text;
  }
  const HOME_DIR = pathDirname(CONFIG_PATH);
  const revoked = revokeHooks(HOME_DIR, [hooksBlockYaml().command], { dryRun: options.dryRun });
  if (revoked) console.log(`  hook allowlist: removed ${revoked}`);
  if (removeNoProxy(HOME_DIR, { dryRun: options.dryRun })) console.log('  no_proxy: removed');
} else {
  const providerUpdates = [];
  const overrideUpdates = [];
  for (const entry of collected) {
    providerUpdates.push([entry.service.id, providerBlockYaml(entry.service, entry.roster, entry.models).join('\n')]);
    const overrides = overridesBlockYaml(entry.service, entry.models);
    if (overrides) overrideUpdates.push([entry.service.id, overrides.join('\n')]);
  }

  const changes = [];
  for (const [key, updates] of [
    ['providers', providerUpdates],
    ['model_overrides', overrideUpdates],
  ]) {
    const merged = mergeInto(original, key, updates);
    const result = patchManagedBlock(text, key, merged.body, { marker: MARKER });
    text = result.text;
    changes.push(`${key}: ${result.action}${options.only ? ` (only ${options.only})` : ''}`);
  }

  if (options.installHooks) {
    const hook = hooksBlockYaml();
    const body = hook.lines.join('\n');
    if (readManagedBlock(text, 'hooks', { marker: MARKER }).trim() !== '') {
      text = patchManagedBlock(text, 'hooks', body, { marker: MARKER }).text;
      changes.push('hooks: replaced');
    } else if (ownsHookSlot(original)) {
      // Someone already hangs a hook on this event. Taking the slot silently
      // would be the kind of surprise that ends with a deleted screenshot.
      console.log('hooks: 已有非托管的 on_session_start 条目 — 跳过(用 --remove 清托管块后手动合并)');
    } else {
      const result = patchManagedBlock(text, 'hooks', body, { marker: MARKER });
      text = result.text;
      changes.push(`hooks: ${result.action}`);
    }

    // Writing the hook is only half of it: hermes refuses to run any
    // (event, command) it has not approved, and silently skips it each session.
    const HOME_DIR = pathDirname(CONFIG_PATH);
    const allowed = allowHook(HOME_DIR, 'on_session_start', hook.command, { dryRun: options.dryRun });
    changes.push(`hook allowlist: ${allowed}`);
    // httpx honours HTTP_PROXY; without this the loopback calls die as
    // "Provider temporarily unavailable".
    const proxied = ensureNoProxy(HOME_DIR, { dryRun: options.dryRun });
    changes.push(`no_proxy: ${proxied}`);
  }
  console.log(changes.map((line) => `  ${line}`).join('\n'));
}

if (text === original) {
  console.log('  nothing changed');
} else if (options.dryRun) {
  console.log(`  --dry-run: ${CONFIG_PATH} not written`);
} else {
  copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  writeFileSync(CONFIG_PATH, text, 'utf8');
  console.log(`  wrote ${CONFIG_PATH}(backup: ${CONFIG_PATH}.bak)`);
}

// --- report -----------------------------------------------------------------

console.log('');
for (const entry of collected) {
  console.log(`${entry.service.id.padEnd(13)} ${String(entry.models.length).padStart(3)} models @ ${entry.roster.baseUrl}`);
}
console.log('');
console.log('选择模型: hermes 里 `/model`,或直接');
console.log(`  ${CONFIG_PATH.replaceAll('\\', '/')}  -> model.provider: ${collected[0].service.id}`);
console.log(`  hermes --provider ${collected[0].service.id} --model <id>`);
console.log('');
console.log('Token 轮换(报 401)或上游名册变化时,重跑本脚本即可。');

if (options.installHooks && !options.remove) {
  console.log('');
  console.log('⚠ 重启 hermes 让两件事生效:');
  console.log('  1. on_session_start hook 重新注册(已写入 allowlist,不会再被跳过)');
  console.log('  2. .env 里的 NO_PROXY(否则 127.0.0.1 的请求会被 HTTP_PROXY 吞掉)');
}

if (options.remove) {
  console.log('');
  console.log(`已移除 ${CONFIG_PATH} 中的 ${MARKER} 托管块${options.dryRun ? ' (--dry-run: 未写盘)' : ''}`);
  console.log(`  suite root: ${SUITE_ROOT}`);
  console.log(`  config:     ${dirname(CONFIG_PATH)}`);
}
