#!/usr/bin/env node
// Run: node --test hermes-connect-services/tests/test-config-regressions.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchManagedBlock, hasTopLevelKey } from '../src/yaml-patch.mjs';
import { ensureNoProxy, removeNoProxy } from '../src/hermes-home.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const TMP = process.env.TMPDIR || join(ROOT, 'tmp');
const CLI = resolve(HERE, '../bin/sync-hermes-config.mjs');
const BOUNDARIES = join(HERE, 'fixtures/config-boundaries.mjs');
const MARKER = 'zcode-ai-connect';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
const hookCommand = `"${process.execPath.replaceAll('\\', '/')}" "${resolve(HERE, '../bin/ensure-services.mjs').replaceAll('\\', '/')}"`;

function fixture(fn) {
  mkdirSync(TMP, { recursive: true });
  const home = mkdtempSync(join(TMP, 'config-regression-'));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

function isolatedEnv(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(no_proxy|node_options|python_dotenv_disabled)$/i.test(key)) delete env[key];
  }
  return {
    ...env, HOME: home, USERPROFILE: home, HERMES_HOME: home,
    LOCALAPPDATA: home, APPDATA: home, AI_CONNECT_SUITE_ROOT: home,
    CONFIG_TEST_TRACE: join(home, 'boundary-trace.txt'),
  };
}

function parseWithPython(home, kind, text) {
  const code = kind === 'dotenv' ? `
import io, json, sys
from dotenv import dotenv_values
print(json.dumps(dotenv_values(stream=io.StringIO(sys.stdin.read()))))
` : `
import json, sys, yaml
class UniqueLoader(yaml.SafeLoader):
    pass
def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError('duplicate YAML key: ' + str(key))
        result[key] = loader.construct_object(value_node, deep=deep)
    return result
UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)
print(json.dumps(yaml.load(sys.stdin.read(), Loader=UniqueLoader)))
`;
  const result = spawnSync('python', ['-I', '-B', '-c', code], {
    cwd: home, env: isolatedEnv(home), input: text, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

function sync(home, args = [], roster = 'online') {
  return spawnSync(process.execPath, ['--import', pathToFileURL(BOUNDARIES).href, CLI, '--config', join(home, 'config.yaml'), ...args], {
    cwd: home, env: { ...isolatedEnv(home), CONFIG_TEST_ROSTER: roster },
    encoding: 'utf8', timeout: 10000,
  });
}

function snapshot(home) {
  return Object.fromEntries(readdirSync(home).filter((name) => name !== 'boundary-trace.txt')
    .map((name) => [name, readFileSync(join(home, name), 'utf8')]));
}

for (const key of ['providers', 'model_overrides', 'hooks']) {
  test(`R01: empty flow ${key} becomes one mapping and keeps comments`, () => fixture((home) => {
    const original = `model: {provider: manual}\n${key}: { } # keep header\ndisplay: {language: zh}\n`;
    assert.equal(hasTopLevelKey(original, key), true);
    const result = patchManagedBlock(original, key, 'zc-fixture:\n  enabled: true');
    const parsed = parseWithPython(home, 'yaml', result.text);
    assert.deepEqual(parsed[key], { 'zc-fixture': { enabled: true } });
    assert.deepEqual(parsed.model, { provider: 'manual' });
    assert.deepEqual(parsed.display, { language: 'zh' });
    assert.match(result.text, /# keep header/);
    assert.equal(patchManagedBlock(result.text, key, 'zc-fixture:\n  enabled: true').changed, false);
    assert.equal(patchManagedBlock(original, key, '').text, original);
  }));

  test(`R01: nonempty flow ${key} is rejected rather than overwritten`, () => {
    const original = `${key}: {manual: {enabled: true}} # retain\n`;
    assert.throws(() => patchManagedBlock(original, key, 'zc-fixture:\n  enabled: true'), /inline|flow/i);
    assert.equal(patchManagedBlock(original, key, '').text, original);
  });

  for (const quote of ['"', "'"]) {
    test(`R01: quoted empty flow ${quote}${key}${quote} stays valid and idempotent`, () => fixture((home) => {
      const original = `${quote}${key}${quote}: {} # keep header\ndisplay: {language: zh}\n`;
      assert.equal(hasTopLevelKey(original, key), true);
      const result = patchManagedBlock(original, key, 'zc-fixture:\n  enabled: true');
      const parsed = parseWithPython(home, 'yaml', result.text);
      assert.deepEqual(parsed[key], { 'zc-fixture': { enabled: true } });
      assert.deepEqual(parsed.display, { language: 'zh' });
      assert.match(result.text, /# keep header/);
      assert.equal(patchManagedBlock(result.text, key, 'zc-fixture:\n  enabled: true').changed, false);
    }));

    test(`R01: CLI rejects quoted nonempty ${quote}${key}${quote} before writing`, () => fixture((home) => {
      const original = `${quote}${key}${quote}: {manual: {enabled: true}}\n`;
      assert.deepEqual(parseWithPython(home, 'yaml', original)[key], { manual: { enabled: true } });
      assert.throws(() => patchManagedBlock(original, key, 'zc-fixture:\n  enabled: true'), /inline|flow/i);
      assert.equal(patchManagedBlock(original, key, '').text, original);
      writeFileSync(join(home, 'config.yaml'), original);
      const before = snapshot(home);
      const result = sync(home, ['--only', 'zc-trae', '--install-hooks']);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /inline|flow/i);
      assert.deepEqual(snapshot(home), before);
    }));
  }

  test(`R01: CLI rejects nonempty ${key} before writing any file`, () => fixture((home) => {
    writeFileSync(join(home, 'config.yaml'), `model: {provider: manual}\n${key}: {manual: {enabled: true}}\n`);
    writeFileSync(join(home, '.env'), 'NO_PROXY=internal.example\n');
    writeFileSync(join(home, 'shell-hooks-allowlist.json'), '{"approvals":[]}\n');
    const before = snapshot(home);
    const result = sync(home, ['--only', 'zc-trae', '--install-hooks']);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /inline|flow/i);
    assert.deepEqual(snapshot(home), before);
  }));
}

test('R01: CLI accepts empty flow maps and stays idempotent', () => fixture((home) => {
  writeFileSync(join(home, 'config.yaml'), 'providers: {} # providers note\nmodel_overrides: {}\nhooks: {}\ndisplay: {language: zh}\n');
  const first = sync(home, ['--only', 'zc-trae', '--install-hooks']);
  assert.equal(first.status, 0, first.stderr);
  const parsed = parseWithPython(home, 'yaml', readFileSync(join(home, 'config.yaml'), 'utf8'));
  assert.ok(parsed.providers['zc-trae']);
  assert.ok(parsed.model_overrides['zc-trae']);
  assert.equal(parsed.hooks.on_session_start[0].timeout, 30);
  assert.deepEqual(parsed.display, { language: 'zh' });
  const before = snapshot(home);
  const second = sync(home, ['--only', 'zc-trae', '--install-hooks']);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(snapshot(home), before);
}));

for (const [name, original, expected] of [
  ['uppercase only', 'NO_PROXY=internal.example,.corp.example\n', ['internal.example', '.corp.example']],
  ['lowercase only', 'no_proxy=lower.example\n', ['lower.example']],
  ['both cases', 'NO_PROXY=upper.example\nno_proxy=lower.example\n', ['upper.example', 'lower.example']],
  ['quotes, comments and effective duplicate', 'NO_PROXY=obsolete.example\nexport NO_PROXY = "internal.example,.corp.example" # ignored\nno_proxy=\'hash#host.example\' # ignored too\nOTHER="NO_PROXY=fake.example"\n', ['internal.example', '.corp.example', 'hash#host.example']],
  ['variable expansion', 'DOMAIN=corp.example\nNO_PROXY="${DOMAIN},upper.example"\nno_proxy="lower.example"\n', ['corp.example', 'upper.example', 'lower.example']],
  ['missing variables', 'OTHER=retained\n', []],
]) {
  test(`R16: preserves dotenv semantics (${name}), is idempotent and removable`, () => fixture((home) => {
    const path = join(home, '.env');
    writeFileSync(path, original);
    const before = parseWithPython(home, 'dotenv', original);
    assert.equal(ensureNoProxy(home), 'wrote');
    const installed = readFileSync(path, 'utf8');
    const parsed = parseWithPython(home, 'dotenv', installed);
    for (const key of ['NO_PROXY', 'no_proxy']) {
      const entries = parsed[key].split(',').filter(Boolean);
      for (const entry of [...expected, ...LOOPBACK]) assert.ok(entries.includes(entry), `${key} lost ${entry}: ${parsed[key]}`);
      assert.ok(!entries.includes('obsolete.example'));
      assert.ok(!entries.includes('fake.example'));
    }
    assert.equal(ensureNoProxy(home), 'present');
    assert.equal(readFileSync(path, 'utf8'), installed);
    assert.equal(removeNoProxy(home), true);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.deepEqual(parseWithPython(home, 'dotenv', readFileSync(path, 'utf8')), before);
    assert.equal(removeNoProxy(home), false);
  }));
}

test('R16: upgrades a legacy managed block without losing later user assignments', () => fixture((home) => {
  const path = join(home, '.env');
  const user = 'NO_PROXY=internal.example\n';
  const legacy = `# >>> ${MARKER} >>>\nNO_PROXY=${LOOPBACK.join(',')}\nno_proxy=${LOOPBACK.join(',')}\n# <<< ${MARKER} <<<\n`;
  writeFileSync(path, `${user}${legacy}no_proxy=after.example\n`);
  assert.equal(ensureNoProxy(home), 'updated');
  const parsed = parseWithPython(home, 'dotenv', readFileSync(path, 'utf8'));
  for (const key of ['NO_PROXY', 'no_proxy']) {
    for (const value of ['internal.example', 'after.example', ...LOOPBACK]) assert.ok(parsed[key].split(',').includes(value), `${key} lost ${value}`);
  }
  assert.equal(ensureNoProxy(home), 'present');
  removeNoProxy(home);
  assert.equal(readFileSync(path, 'utf8'), `${user}no_proxy=after.example\n`);
}));

test('R16: side-file dry-run never creates or changes files', () => fixture((home) => {
  assert.equal(ensureNoProxy(home, { dryRun: true }), 'skipped-dry-run');
  assert.deepEqual(readdirSync(home), []);
  writeFileSync(join(home, '.env'), 'no_proxy=internal.example\n');
  const before = snapshot(home);
  ensureNoProxy(home, { dryRun: true });
  assert.deepEqual(snapshot(home), before);
  ensureNoProxy(home);
  const installed = snapshot(home);
  assert.equal(removeNoProxy(home, { dryRun: true }), true);
  assert.deepEqual(snapshot(home), installed);
}));

const unmanagedConfig = 'model: {provider: manual}\nproviders:\n  manual: {base_url: "https://example.test"}\nmodel_overrides:\n  manual: {context_window: 8192}\nhooks:\n  on_other_event: [{command: manual}]\n';
function seedInstalled(home) {
  let config = unmanagedConfig;
  for (const key of ['providers', 'model_overrides', 'hooks']) {
    config = patchManagedBlock(config, key, key === 'hooks' ? 'on_session_start:\n  - command: fixture' : 'zc-trae:\n  fixture: true').text;
  }
  writeFileSync(join(home, 'config.yaml'), config);
  writeFileSync(join(home, '.env'), `NO_PROXY=internal.example\n# >>> ${MARKER} >>>\nNO_PROXY=${LOOPBACK.join(',')}\nno_proxy=${LOOPBACK.join(',')}\n# <<< ${MARKER} <<<\n`);
  writeFileSync(join(home, 'shell-hooks-allowlist.json'), `${JSON.stringify({ version: 1, approvals: [
    { event: 'on_other_event', command: 'manual', approved_at: 'retained' },
    { event: 'on_session_start', command: hookCommand },
  ] })}\n`);
}

for (const roster of ['offline', 'online']) {
  test(`R17: --remove succeeds with ${roster} endpoints without discovery or startup`, () => fixture((home) => {
    seedInstalled(home);
    const result = sync(home, ['--remove', '--ensure', '--install-hooks'], roster);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(home, 'boundary-trace.txt')), false, 'remove must not fetch or spawn');
    assert.equal(readFileSync(join(home, 'config.yaml'), 'utf8'), unmanagedConfig);
    assert.equal(readFileSync(join(home, '.env'), 'utf8'), 'NO_PROXY=internal.example\n');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'shell-hooks-allowlist.json'), 'utf8')), {
      version: 1, approvals: [{ event: 'on_other_event', command: 'manual', approved_at: 'retained' }],
    });
    const before = snapshot(home);
    const twice = sync(home, ['--remove'], roster);
    assert.equal(twice.status, 0, twice.stderr);
    assert.deepEqual(snapshot(home), before);
  }));
}

test('R17: offline --remove --dry-run changes no files or backups', () => fixture((home) => {
  seedInstalled(home);
  const before = snapshot(home);
  const result = sync(home, ['--remove', '--dry-run', '--ensure'], 'offline');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(join(home, 'boundary-trace.txt')), false);
  assert.deepEqual(snapshot(home), before);
}));
