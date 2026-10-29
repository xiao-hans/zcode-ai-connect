/**
 * Regression tests for the pi-turn-guard extension.
 *
 *   node tests/test-pi-turn-guard.mjs
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 守卫挂在 pi-connect-services 上（不是独立包）：它不依赖任何 provider 的凭据，
// 加载可靠；而 pi-provider-qwenwork 在 shim 起不来时直接 return，守卫会消失。
const { installTurnGuard, MAX_AUTO_CONTINUES } = await import(
  pathToFileURL(join(HERE, '..', 'pi-connect-services', 'index.js')).href
);

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}  ${detail}`);
  }
}

/** 最小的 pi 宿主替身：只实现扩展用到的 on / logger。 */
function fakePi() {
  const handlers = new Map();
  const logs = [];
  return {
    logs,
    logger: { info: (m) => logs.push(String(m)), debug: () => {} },
    on: (name, fn) => handlers.set(name, fn),
    fire: (name, arg) => (handlers.has(name) ? handlers.get(name)(arg) : undefined),
  };
}

function settle({ provider = 'workbuddy', blocks = [], outcome = 'completed', cont = false, entries = [] }) {
  return {
    outcome,
    continue: cont,
    entries,
    context: {
      llmMessages: [{ role: 'assistant', provider, stopReason: 'stop', content: blocks }],
    },
  };
}

const THINKING_ONLY = [{ type: 'thinking', thinking: '' }];
const STALL_TEXT = [{ type: 'text', text: '接下来我会先检查一下网关的配置文件，然后把 provider 那一节补上：' }];
const DONE_TEXT = [{ type: 'text', text: '已经完成全部修改，测试通过。' }];

function mount() {
  const pi = fakePi();
  installTurnGuard(pi);
  return pi;
}

console.log('[1] empty turn — thinking only, no text, no tools');
{
  const pi = mount();
  const r = pi.fire('agent_before_settle', settle({ provider: 'workbuddy', blocks: THINKING_ONLY }));
  check('workbuddy empty turn -> continue', r?.continue === true);
  check('uses the empty-turn prompt', String(r?.entries?.at(-1)?.content ?? '').includes('只留下了思考过程'));
  check('keeps pre-existing entries', Array.isArray(r?.entries));
}
{
  // qwenwork 有自己的 stall 守卫，但空回合谁都没管 —— 所以这个也要续跑。
  const pi = mount();
  const r = pi.fire('agent_before_settle', settle({ provider: 'qwenwork', blocks: THINKING_ONLY }));
  check('qwenwork empty turn -> continue (nobody else handles it)', r?.continue === true);
}

console.log('\n[2] stall — only for providers without their own guard');
{
  const pi = mount();
  const r = pi.fire('agent_before_settle', settle({ provider: 'workbuddy', blocks: STALL_TEXT }));
  check('workbuddy stall -> continue', r?.continue === true);
}
{
  const pi = mount();
  const r = pi.fire('agent_before_settle', settle({ provider: 'qwenwork', blocks: STALL_TEXT }));
  check('qwenwork stall -> left to its own guard', r === undefined);
}

console.log('\n[3] must not fire');
{
  const pi = mount();
  check('user-aborted turn -> no continue',
    pi.fire('agent_before_settle', settle({ outcome: 'aborted', blocks: THINKING_ONLY })) === undefined);
}
{
  const pi = mount();
  check('another guard already asked to continue -> no continue',
    pi.fire('agent_before_settle', settle({ cont: true, blocks: THINKING_ONLY })) === undefined);
}
{
  const pi = mount();
  check('tool calls present -> no continue',
    pi.fire('agent_before_settle', settle({ blocks: [...THINKING_ONLY, { type: 'toolCall' }] })) === undefined);
}
{
  const pi = mount();
  check('normal closing text -> no continue',
    pi.fire('agent_before_settle', settle({ blocks: DONE_TEXT })) === undefined);
}
{
  const pi = mount();
  check('stopReason length (truncated) -> no continue',
    pi.fire('agent_before_settle', (() => {
      const e = settle({ blocks: THINKING_ONLY });
      e.context.llmMessages[0].stopReason = 'length';
      return e;
    })()) === undefined);
}

console.log('\n[4] budget');
{
  const pi = mount();
  const results = [];
  for (let i = 0; i < MAX_AUTO_CONTINUES + 2; i += 1) {
    results.push(pi.fire('agent_before_settle', settle({ blocks: STALL_TEXT })));
  }
  const continued = results.filter((r) => r?.continue === true).length;
  check(`at most ${MAX_AUTO_CONTINUES} auto-continues per input`, continued === MAX_AUTO_CONTINUES, `got ${continued}`);
}
{
  const pi = mount();
  pi.fire('agent_before_settle', settle({ blocks: STALL_TEXT }));
  pi.fire('agent_before_settle', settle({ blocks: STALL_TEXT }));
  check('budget exhausted', pi.fire('agent_before_settle', settle({ blocks: STALL_TEXT })) === undefined);
  pi.fire('input', {});
  check('new user input resets the budget',
    pi.fire('agent_before_settle', settle({ blocks: STALL_TEXT }))?.continue === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
