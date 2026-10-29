#!/usr/bin/env node
/**
 * Regressions for the YAML patcher — the one piece of this module that can
 * corrupt a user's config, so it gets tests instead of good intentions.
 *
 * Run: node hermes-connect-services/tests/test-yaml-patch.mjs
 */
import assert from 'node:assert/strict';
import { patchManagedBlock, readManagedBlock, readManagedChildren } from '../src/yaml-patch.mjs';

const MARKER = 'zcode-ai-connect';
const sample = [
  'model:',
  '  provider: nous',
  'providers:',
  '  xiaoxin:',
  '    name: xiaoxin',
  '    base_url: https://example.test',
  'fallback_providers: []',
  '',
  '# trailing comment that must survive',
  'display:',
  '  language: zh',
  '',
].join('\n');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

console.log('test-yaml-patch');

check('inserts a managed region inside an existing mapping', () => {
  const { text, action } = patchManagedBlock(sample, 'providers', 'zc-trae:\n  base_url: "http://127.0.0.1:1/v1"', { marker: MARKER });
  assert.equal(action, 'inserted');
  assert.match(text, /providers:\n  xiaoxin:/);
  assert.match(text, /# >>> zcode-ai-connect >>>\n {2}zc-trae:/);
  assert.match(text, /fallback_providers: \[\]/);
});

check('replaces its own region and leaves foreign keys alone', () => {
  const first = patchManagedBlock(sample, 'providers', 'zc-trae:\n  base_url: "a"', { marker: MARKER }).text;
  const second = patchManagedBlock(first, 'providers', 'zc-trae:\n  base_url: "b"', { marker: MARKER }).text;
  assert.match(second, /base_url: "b"/);
  assert.match(second, /  xiaoxin:/);
  assert.equal(readManagedChildren(second, 'providers', { marker: MARKER }).length, 1);
});

check('is idempotent: re-patching identical content writes no change', () => {
  const once = patchManagedBlock(sample, 'providers', 'zc-trae:\n  base_url: "a"', { marker: MARKER }).text;
  const twice = patchManagedBlock(once, 'providers', 'zc-trae:\n  base_url: "a"', { marker: MARKER });
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once);
});

check('removal restores the original bytes exactly', () => {
  const once = patchManagedBlock(sample, 'providers', 'zc-trae:\n  base_url: "a"', { marker: MARKER }).text;
  const gone = patchManagedBlock(once, 'providers', '', { marker: MARKER }).text;
  assert.equal(gone, sample);
});

check('creates the top-level key when it is missing', () => {
  const { text, action } = patchManagedBlock(sample, 'model_overrides', 'zc-trae:\n  "id":\n    supports_tools: true', { marker: MARKER });
  assert.equal(action, 'inserted');
  assert.match(text, /\nmodel_overrides:\n {2}# >>> zcode-ai-connect >>>/);
  assert.match(text, /display:\n {2}language: zh/);
});

check('never touches content outside its own mapping', () => {
  const { text } = patchManagedBlock(sample, 'providers', 'zc-trae:\n  base_url: "a"', { marker: MARKER });
  assert.equal(readManagedBlock(text, 'model', { marker: MARKER }), '');
  assert.match(text, /model:\n {2}provider: nous/);
});

check('readManagedChildren round-trips every provider id', () => {
  const body = [
    'zc-trae:',
    '  base_url: "http://127.0.0.1:39272/v1"',
    '  models:',
    '    "a": {}',
    'zc-workbuddy:',
    '  base_url: "http://127.0.0.1:39271/v1"',
  ].join('\n');
  const once = patchManagedBlock(sample, 'providers', body, { marker: MARKER }).text;
  const children = readManagedChildren(once, 'providers', { marker: MARKER });
  assert.deepEqual(children.map((c) => c.key), ['zc-trae', 'zc-workbuddy']);
  assert.match(children[0].body, /models:\n {4}"a": \{\}/);
  // Feeding them back unchanged must be a no-op — this is what keeps `--only`
  // from silently deleting the providers it was not asked about.
  const twice = patchManagedBlock(once, 'providers', children.map((c) => c.body).join('\n'), { marker: MARKER });
  assert.equal(twice.text, once);
});

check('survives an unterminated marker (hand-edit gone wrong)', () => {
  // A hand-edit that dropped the closing marker leaves an orphan inside the
  // providers mapping — the next sync must repair it, not stack a second one.
  const broken = sample.replace(
    'fallback_providers: []',
    `  # >>> ${MARKER} >>>\n  zc-trae:\n    base_url: "a"\nfallback_providers: []`,
  );
  const repaired = patchManagedBlock(broken, 'providers', 'zc-trae:\n  base_url: "a"', { marker: MARKER });
  assert.equal(repaired.text.match(new RegExp(`# >>> ${MARKER} >>>`, 'g')).length, 1);
  assert.match(repaired.text, /# <<< zcode-ai-connect <<</);
});

check('reclaims an orphaned region whose opening marker hermes ate', () => {
  // Real-world shape: hermes rewrote config.yaml from its own model and kept the
  // body plus the closing marker, losing only the opening one. A naive patcher
  // reads "no region" and inserts a second copy of every provider — duplicate
  // top-level keys that PyYAML silently collapses.
  const orphan = [
    'providers:',
    '  xiaoxin:',
    '    name: xiaoxin',
    '  zc-trae:',
    '    base_url: "a"',
    `  # <<< ${MARKER} <<<`,
    'fallback_providers: []',
    '',
  ].join('\n');
  const fixed = patchManagedBlock(orphan, 'providers', 'zc-trae:\n  base_url: "b"', { marker: MARKER });
  assert.equal(fixed.action, 'replaced');
  assert.equal(fixed.text.match(new RegExp(`# >>> ${MARKER} >>>`, 'g')).length, 1);
  assert.equal(fixed.text.match(new RegExp(`# <<< ${MARKER} <<<`, 'g')).length, 1);
  // The hand-written provider above ours survives; ours is rewritten.
  assert.match(fixed.text, / {2}xiaoxin:\n {4}name: xiaoxin/);
  assert.match(fixed.text, /base_url: "b"/);
  // And it is stable from now on.
  assert.equal(patchManagedBlock(fixed.text, 'providers', 'zc-trae:\n  base_url: "b"', { marker: MARKER }).changed, false);
});

console.log(`\n${passed} passed`);
