#!/usr/bin/env node
/**
 * hermes 侧续跑闸门的回归测试。
 *
 * 直接 import 宿主的 `apply_stop_gates`,让**整条闸门链**真实跑一遍 —— late-LSP /
 * verify-on-stop / pre_verify / kanban 四道闸都会执行,只是触发条件不成立。这比
 * mock 一个函数名对得上要有说服力:它证明我们的闸门插在了正确的位置,而且返回值
 * 形状能让 turn loop 接受。
 *
 * 本机没装 hermes 时 SKIP(不判失败),这样 CI 上也能通过。
 *
 * Run: node hermes-connect-services/tests/test-stall-gate.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? '';

console.log('test-stall-gate (hermes)');

function locateAgentRoot() {
  const homes = [
    process.env.HERMES_HOME,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hermes') : null,
    join(HOME_DIR, '.hermes'),
  ].filter(Boolean);
  for (const home of homes) {
    const root = join(home, 'hermes-agent');
    if (existsSync(join(root, 'agent', 'turn_stop_gates.py'))) return { home, root };
  }
  return null;
}

function findPython(home) {
  const candidates = [
    process.env.HERMES_PYTHON,
    join(home, 'tools', 'python-3.14.9+20261021-win32-x64', 'python.exe'),
    'python',
    'python3',
  ].filter(Boolean);
  for (const exe of candidates) {
    const probe = spawnSync(exe, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 15000 });
    if (probe.status === 0 && probe.stdout.trim() === '1') return exe;
  }
  return null;
}

const located = locateAgentRoot();
if (!located) {
  console.log('  SKIP 本机没有 hermes（找过 HERMES_HOME / LOCALAPPDATA / ~/.hermes）');
  process.exit(0);
}

const gatePath = join(located.root, 'agent', 'turn_stop_gates.py');
const patched = existsSync(gatePath)
  && spawnSync(process.execPath, ['-e', `process.exit(require('fs').readFileSync(${JSON.stringify(gatePath)},'utf8').includes('zcode-ai-connect stall-guard')?0:1)`]).status === 0;
if (!patched) {
  console.log('  SKIP 补丁未打（先跑 bin/patch-hermes-stall-gate.mjs）');
  process.exit(0);
}

const python = findPython(located.home);
if (!python) {
  console.log('  SKIP 找不到 Python 解释器');
  process.exit(0);
}

const probe = spawnSync(python, [join(HERE, 'probe_stall_gate.py'), located.root], {
  encoding: 'utf8', timeout: 60000, cwd: located.root,
});
if (probe.status !== 0) {
  console.log(`  FAIL 探针执行失败（status=${probe.status}）`);
  console.log((probe.stderr || probe.stdout || '').slice(0, 1500));
  process.exit(1);
}

const lines = probe.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
let passed = 0;
let failed = 0;

const meta = JSON.parse(lines[0]);
console.log(`  max nudges = ${meta.max_nudges}`);
if (meta.max_nudges !== 2) {
  failed += 1;
  console.log(`  FAIL max nudges = ${meta.max_nudges} (expect 2, 与 ZCode / pi / dsh 一致)`);
}

for (const line of lines.slice(1)) {
  const r = JSON.parse(line);
  if (r.name === 'per-turn-budget') {
    const sameTurnOk = JSON.stringify(r.same_turn) === JSON.stringify([true, true, false]);
    const resetOk = r.after_new_user === true;
    if (sameTurnOk && resetOk) {
      passed += 1;
      console.log(`  ok   per-turn-budget → ${JSON.stringify(r.same_turn)} 且新用户消息后重置`);
    } else {
      failed += 1;
      console.log(`  FAIL per-turn-budget → same_turn=${JSON.stringify(r.same_turn)} after_new_user=${r.after_new_user}`);
    }
    continue;
  }
  const ok = r.continue_turn === r.expect;
  if (ok) {
    passed += 1;
    const extra = r.continue_turn ? ` nudge→${r.nudge_role} fallback=${r.fallback ? 'kept' : 'LOST'}` : '';
    console.log(`  ok   ${r.name} → continue_turn=${r.continue_turn}${extra}`);
    // 续跑时必须把候选答案留作 fallback,否则预算耗尽时用户什么都看不到
    if (r.continue_turn && !r.fallback) {
      failed += 1;
      passed -= 1;
      console.log(`       FAIL ${r.name}: pending_verification_response 丢了`);
    }
  } else {
    failed += 1;
    console.log(`  FAIL ${r.name} → continue_turn=${r.continue_turn} (expect ${r.expect})`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
