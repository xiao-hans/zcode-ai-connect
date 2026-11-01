/**
 * Regression tests for the Claude Code Stop hook (scripts/claude-stall-guard.mjs).
 *
 * Like the ZCode guard, this hook is a short-lived process: it cannot hold
 * in-memory state, so dedupe and the per-turn continuation budget are atomic
 * file claims. These tests drive the real hook as a subprocess against
 * synthetic transcripts and assert on stdout (which must be pure JSON or empty).
 *
 *   node tests/test-claude-stall-guard.mjs
 *
 * 覆盖的回归点(都来自 2026-11-01 实测):
 *   - 裸「是否」不得再被判 asked-user 放行
 *     (「安装成功。现在启动应用,验证是否不再崩溃。」曾被静默放过);
 *   - 同一段回复文本只续跑一次;
 *   - 同一回合预算 MAX_AUTO_CONTINUES 次,换句话也说不动第 4 次;
 *   - 过短问句(「要我接着做哪条？」)必须放行 —— 长度闸门排在否决规则之前,
 *     不单独处理会误续跑;
 *   - 明确完成态放行;
 *   - 垃圾输入 / transcript 缺失一律静默 exit 0,不得往 stdout 写杂音。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'scripts', 'claude-stall-guard.mjs');
const WORK = mkdtempSync(join(tmpdir(), 'zc-claude-guard-'));
const LOCK_HOME = join(WORK, 'locks');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

/** @returns {Promise<{out:string, err:string, code:number}>} */
function runHook(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ZCLAUDE_STALL_GUARD_HOME: LOCK_HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ out, err, code }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

let seq = 0;
/** 写一份「一轮真人输入 + 一条 assistant 收尾」的合成 transcript。 */
function transcript(turnText, replyText) {
  seq += 1;
  const path = join(WORK, `t${seq}.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user', content: turnText } },
    {
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: replyText }] },
    },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  return path;
}

const userPrompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolTurn = () => ({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }] },
});
const stallTurn = (text) => ({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});
const hookFeedback = () => ({
  type: 'user',
  isMeta: true,
  message: { role: 'user', content: 'Stop hook feedback:\n继续执行:直接调用工具把剩下的步骤做完。' },
});

/** 写一份任意条目序列的 transcript。 */
function rawTranscript(items) {
  seq += 1;
  const path = join(WORK, `r${seq}.jsonl`);
  writeFileSync(path, `${items.map((o) => JSON.stringify(o)).join('\n')}\n`, 'utf8');
  return path;
}

async function stopEvent(file, extra = {}, sessionId = `s-${file}`) {
  const { out, err, code } = await runHook({
    session_id: sessionId,
    transcript_path: file,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...extra,
  });
  let blocked = false;
  let parseable = true;
  if (out.trim() !== '') {
    try {
      blocked = JSON.parse(out).decision === 'block';
    } catch {
      parseable = false;
    }
  }
  return { blocked, parseable, raw: out, err, code };
}

console.log('[1] 裸「是否」不再被当成把决定权交回用户');
{
  const a = await stopEvent(transcript('把崩溃修好', '安装成功。现在启动应用，验证是否不再崩溃。'));
  check('「验证是否不再崩溃。」→ 续跑', a.blocked, a.raw);
  const b = await stopEvent(transcript('修好依赖', 'PlaybackProbe 在 shared 模块，ui 模块可能没有依赖它。我先确认 ui 是否已经引用。'));
  check('「我先确认 ui 是否已经引用。」→ 续跑', b.blocked, b.raw);
}

console.log('[2] 同一段回复文本只续跑一次');
{
  const file = transcript('跑验证', '我先改 Adapter 的构造参数。');
  const first = await stopEvent(file, { stop_hook_active: true });
  check('首次续跑', first.blocked, first.raw);
  const second = await stopEvent(file, { stop_hook_active: true });
  check('同一文本第二次不续跑', !second.blocked, second.raw);
}

console.log('[3] 续跑预算按「有没有真干活」算,不按次数算');
{
  // 救完之后模型真的调过工具 → 下一次停住是新的,应该继续救
  const progressed = rawTranscript([
    userPrompt('跑一遍验证'),
    toolTurn(),
    stallTurn('接下来把缓存键换成分类 id。'),
    hookFeedback(),
    toolTurn(),                                   // 干了活
    stallTurn('再补一条回归测试。'),                 // 又停了
  ]);
  const a = await stopEvent(progressed, {}, 's-progress');
  check('中间有工具调用 → 继续续跑', a.blocked, a.raw);

  // 救完原地不动,连续两次 → 死循环,不再烧额度
  const looping = rawTranscript([
    userPrompt('跑一遍验证'),
    toolTurn(),
    stallTurn('接下来改适配器。'),
    hookFeedback(),
    stallTurn('接下来改适配器。'),
    hookFeedback(),
    stallTurn('接下来改适配器。'),
  ]);
  const b = await stopEvent(looping, {}, 's-loop');
  check('连续两次没干活 → 判定死循环放行', !b.blocked, b.raw);
}

console.log('[4] 空消息收尾(轮内已有工具调用也要救)');
{
  const file = transcript('继续装', '');
  const { blocked, raw } = await stopEvent(file, { stop_hook_active: false }, 's-empty');
  check('末条消息内容为空 → 续跑', blocked, raw);
}

console.log('[5] 放行场景');
{
  const done = await stopEvent(transcript('改完了吗', '两处改动都已落盘，编译和 785 例测试全部通过。修好了。'));
  check('明确完成态 → 放行', !done.blocked, done.raw);
  const short = await stopEvent(transcript('怎么办', '要我接着做哪条？'));
  check('过短问句 → 放行', !short.blocked, short.raw);
  const ask = await stopEvent(transcript('怎么弄', '需要你先确认端口号，我再继续。'));
  check('交回决定权 → 放行', !ask.blocked, ask.raw);
}

console.log('[6] 同一个词发两次 = 两个回合,预算不共用');
{
  // 用户反复发「继续」时,只按 prompt 文本算回合会把两次输入算成同一轮,
  // 第二轮的续跑预算一开始就被上一轮用光(实测 23:11/23:11/23:14/23:18 连续
  // 四次「turn cap reached」)。回合身份必须带上时间戳。
  const t1 = rawTranscript([
    { type: 'user', timestamp: '2026-11-01T15:00:00.000Z', message: { role: 'user', content: '继续' } },
    stallTurn('先读关键文件确认现状。'),
  ]);
  const t2 = rawTranscript([
    { type: 'user', timestamp: '2026-11-01T15:18:00.000Z', message: { role: 'user', content: '继续' } },
    stallTurn('先读关键文件确认现状。'),
  ]);
  const a = await stopEvent(t1, {}, 's-turn');
  check('第一轮 → 续跑', a.blocked, a.raw);
  const b = await stopEvent(t2, {}, 's-turn');   // 同 session、同文本、不同时间戳
  check('第二轮同词同句 → 仍然续跑', b.blocked, b.raw);
}

console.log('[7] 异常输入静默退出');
{
  const junk = await runHook('not json at all');
  check('非 JSON stdin → 无输出', junk.out.trim() === '' && junk.code === 0, `${junk.out} / ${junk.code}`);
  const missing = await stopEvent(join(WORK, 'does-not-exist.jsonl'));
  check('transcript 缺失 → 无输出', missing.raw.trim() === '' && missing.code === 0, missing.raw);
  const noPath = await runHook({ hook_event_name: 'Stop', stop_hook_active: false });
  check('缺 transcript_path → 无输出', noPath.out.trim() === '' && noPath.code === 0, noPath.out);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
