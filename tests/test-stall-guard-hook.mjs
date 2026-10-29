/**
 * Regression tests for the ZCode Stop hook (hooks/stall-guard.mjs).
 *
 * The hook is a short-lived process: it cannot hold in-memory state, so the
 * dedupe and the per-turn continuation budget are both expressed as atomic
 * file claims. These tests drive the real hook as a subprocess and assert on
 * its stdout (which must be pure JSON).
 *
 *   node tests/test-stall-guard-hook.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'zcode-trae-connect', 'hooks', 'stall-guard.mjs');
const LOCK_HOME = mkdtempSync(join(tmpdir(), 'zc-stall-guard-'));

let passed = 0;
let failed = 0;

/** @returns {Promise<{out:string, err:string}>} */
function runHook(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ZCODE_STALL_GUARD_HOME: LOCK_HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => resolve({ out, err }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

/** @returns {Promise<{blocked:boolean, raw:string, err:string}>} */
async function hookSays(input) {
  const { out, err } = await runHook(input);
  let blocked = false;
  try {
    blocked = JSON.parse(out).decision === 'block';
  } catch {
    blocked = false;
  }
  return { blocked, raw: out, err };
}

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}  ${detail}`);
  }
}

const STALL_A = '接下来我会先检查一下网关的配置文件，然后把 provider 那一节补上：';
const STALL_B = '好的，我已经看完了，现在把这份配置整份重写干净：';
const STALL_C = '我先把这三个包的版本号对齐，然后逐个跑一次发布：';

async function main() {
  console.log(`[lock home] ${LOCK_HOME}`);

  // A model that keeps announcing without acting must not be able to loop forever.
  console.log('\n[1] per-turn budget');
  const a1 = await hookSays({ session_id: 's1', turnId: 't1', toolCallCount: 0, responseText: STALL_A });
  check('first stall in a turn -> block', a1.blocked, a1.raw.slice(0, 40));

  const a2 = await hookSays({ session_id: 's1', turnId: 't1', toolCallCount: 0, responseText: STALL_A });
  check('same text again -> no block (dedupe)', !a2.blocked);

  const b1 = await hookSays({ session_id: 's1', turnId: 't1', toolCallCount: 0, responseText: STALL_B });
  check('second distinct stall -> block (budget 2/2)', b1.blocked);

  const c1 = await hookSays({ session_id: 's1', turnId: 't1', toolCallCount: 0, responseText: STALL_C });
  check('third distinct stall -> blocked by budget', !c1.blocked);

  console.log('\n[2] a new turn resets the budget');
  const d1 = await hookSays({ session_id: 's1', turnId: 't2', toolCallCount: 0, responseText: STALL_A });
  check('new turn -> block again', d1.blocked);

  console.log('\n[3] non-stall and malformed input');
  const done = await hookSays({ session_id: 's1', turnId: 't3', toolCallCount: 0, responseText: '已经完成全部修改，测试通过。' });
  check('completion text -> no block', !done.blocked);
  const withTools = await hookSays({ session_id: 's1', turnId: 't3', toolCallCount: 2, responseText: STALL_A });
  check('toolCallCount > 0 -> no block', !withTools.blocked);
  const junk = await hookSays('not json at all');
  check('malformed stdin -> no block, exit 0', !junk.blocked);
  const empty = await hookSays('');
  check('empty stdin -> no block', !empty.blocked);

  console.log('\n[4] empty turn: only thinking, no text, no tools');
  const e1 = await hookSays({ session_id: 's9', turnId: 't9', toolCallCount: 0, responseText: '' });
  check('empty text + no tools -> block', e1.blocked);
  check('uses the empty-turn prompt, not the stall one', e1.raw.includes('只留下了思考过程'), e1.raw.slice(0, 40));

  const e2 = await hookSays({ session_id: 's9', turnId: 't9', toolCallCount: 0, responseText: '   \n  ' });
  check('whitespace-only text -> block', e2.blocked);

  const e3 = await hookSays({ session_id: 's9', turnId: 't9', toolCallCount: 2, responseText: '' });
  check('empty text but tools did run -> no block', !e3.blocked);

  console.log('\n[5] stdout is always parseable JSON');
  for (const [label, r] of [['stall', a1], ['dedupe', a2], ['budget', c1], ['junk', junk]]) {
    let okJson = false;
    try { JSON.parse(r.raw); okJson = true; } catch { okJson = false; }
    check(`${label} emits valid JSON`, okJson, JSON.stringify(r.raw.slice(0, 30)));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
