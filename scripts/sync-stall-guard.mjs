#!/usr/bin/env node
/**
 * 把 shared/stall-detector.mjs 与 Stop hook 分发到四个 ZCode 连接器包。
 *
 * 四个包要各自独立发布到 npm，所以不能靠跨包 import；检测逻辑必须物理复制。
 * 权威源只有 `shared/stall-detector.mjs`，改完跑一次本脚本即可。
 *
 *   node scripts/sync-stall-guard.mjs [--dry-run] [--bump]
 *
 * @module zcode-ai-connect/scripts/sync-stall-guard
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DETECTOR_SOURCE = join(ROOT, 'shared', 'stall-detector.mjs');
const GUARD_SOURCE = join(ROOT, 'zcode-trae-connect', 'hooks', 'stall-guard.mjs');
const PACKAGES = ['zcode-trae-connect', 'zcode-workbuddy-connect', 'zcode-qoder-connect', 'zcode-qwenwork-connect'];

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const bump = argv.includes('--bump');

const detector = readFileSync(DETECTOR_SOURCE, 'utf8');
const guard = readFileSync(GUARD_SOURCE, 'utf8');

/** Stop 段：不带 matcher —— 对 Stop 事件 matcher 无意义，写它只会误导读者。 */
const STOP_HOOK = {
  hooks: [
    {
      type: 'process',
      command: 'node',
      args: ['${ZCODE_PLUGIN_ROOT}/hooks/stall-guard.mjs'],
      timeoutMs: 15000,
      statusMessage: 'Checking for an announced-but-unexecuted step',
    },
  ],
};

let touched = 0;
for (const pkg of PACKAGES) {
  const pkgDir = join(ROOT, pkg);
  const hooksDir = join(pkgDir, 'hooks');
  if (!existsSync(hooksDir)) {
    console.log(`  ${pkg}: skip (no hooks/ dir)`);
    continue;
  }

  const detectorTarget = join(hooksDir, 'stall-detector.mjs');
  if (!dryRun) writeFileSync(detectorTarget, detector, 'utf8');
  console.log(`  ${pkg}: hooks/stall-detector.mjs ${existsSync(detectorTarget) ? 'updated' : 'created'}`);
  touched += 1;

  // trae 是模板本体，不覆盖自己。
  if (pkg !== 'zcode-trae-connect') {
    if (!dryRun) copyFileSync(GUARD_SOURCE, join(hooksDir, 'stall-guard.mjs'));
    console.log(`  ${pkg}: hooks/stall-guard.mjs synced`);
  }

  const manifestPath = join(pkgDir, '.zcode-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.hooks ??= {};

  const existing = manifest.hooks.Stop;
  const ownStop = (slot) => Array.isArray(slot)
    && slot.some((g) => (g?.hooks ?? []).some((h) => (h?.args ?? []).some((a) => String(a).includes('stall-guard'))));

  if (ownStop(existing)) {
    console.log(`  ${pkg}: plugin.json Stop already registered`);
  } else if (Array.isArray(existing) && existing.length > 0) {
    // 用户自己配了 Stop，追加而不是替换。
    manifest.hooks.Stop = [...existing, STOP_HOOK];
    if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`  ${pkg}: plugin.json Stop appended`);
    touched += 1;
  } else {
    manifest.hooks.Stop = [STOP_HOOK];
    if (bump) {
      const [major, minor] = String(manifest.version ?? '1.0.0').split('.').map(Number);
      manifest.version = `${major || 1}.${(minor || 0) + 1}.0`;
    }
    if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`  ${pkg}: plugin.json Stop registered${bump ? ` (v${manifest.version})` : ''}`);
    touched += 1;
  }
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}${touched} file(s) ${dryRun ? 'would be ' : ''}written`);
