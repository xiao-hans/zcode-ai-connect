#!/usr/bin/env node
/**
 * claude-stall-guard.mjs — Claude Code Stop hook:模型「宣布了下一步却直接停住」
 * /「只回了个『继续』」/「只留思考不说话」时,自动续跑一轮。
 *
 * 判定与 ZCode/pi/dsh/hermes 四个宿主共用同一套 shared/stall-detector.mjs
 * (test-detector-parity.mjs 保证 JS/Python 两实现一致);本文件只做 Claude 的 IO:
 *
 * Claude Stop hook 契约:
 *   stdin:  {session_id, transcript_path, hook_event_name:"Stop", stop_hook_active, ...}
 *   stdout: {"decision":"block","reason":"…"} → reason 回灌上下文,模型继续;
 *           无输出(或 {}) = 正常结束这一轮。
 *
 * 铁律(与 zcode-trae-connect/hooks/stall-guard.mjs 相同):
 *   1. stdout 只能是纯 JSON,任何一行杂音都会让整次输出作废;日志走 stderr。
 *   2. 绝不 exit 2:对 Stop 事件 exit 2 等价于把 stderr 当续跑指令,异常路径一律
 *      静默 exit 0(漏续跑的代价远小于错续跑)。
 *   3. stop_hook_active=true 说明本轮已续跑过一次,不再续(防循环)。
 *   4. 本轮只要有过工具调用就不判(stall 只针对「只说不做」)。
 *
 * 轮次起点判定:从尾部回溯,最近一条「真人输入」(content 非纯 tool_result 的
 * user 条目)为本轮起点——tool_result 条目是工具回传,属于轮内。
 */
import { readFileSync } from 'node:fs';
import { detectStall, EMPTY_TURN_PROMPT } from '../shared/stall-detector.mjs';

const FALLBACK_REASON = [
  '你上一条回复在任务进行到一半时停住了,没有宣布结束,也没有调用工具继续。',
  '请接着把刚才正在做的事做完;如果确实已经完成或需要用户决定,用一句话说明。',
].join('\n');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function lastTurnStats(entries) {
  let toolCalls = 0;
  let lastText = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const o = entries[i];
    if (o.type === 'user' && o.message?.content !== undefined) {
      const c = o.message.content;
      const isToolResult = Array.isArray(c) && c.length > 0 && c.every(p => p && p.type === 'tool_result');
      if (!isToolResult) break; // 本轮起点(真人输入)
    }
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const p of o.message.content) {
        if (p?.type === 'tool_use') toolCalls++;
        // 逆序回溯:第一条找到的文本就是时间上最末的 assistant 文本,不可被更早的覆盖
        if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim() && !lastText) lastText = p.text;
      }
    }
  }
  return { toolCalls, lastText };
}

try {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw); } catch { process.exit(0); }
  if (event.stop_hook_active) process.exit(0); // 本轮已续跑过,防循环
  if (!event.transcript_path) process.exit(0);

  const entries = readFileSync(event.transcript_path, 'utf8')
    .trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.type === 'assistant' || o && o.type === 'user');
  if (!entries.length) process.exit(0);

  const { toolCalls, lastText } = lastTurnStats(entries);
  if (!lastText) {
    // 纯思考/空回合:零工具调用零文本 → 要求把结论说出来(EMPTY_TURN_PROMPT,
    // 对应实测的「思考着,突然不工作了」)
    if (toolCalls === 0) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: EMPTY_TURN_PROMPT }));
    }
    process.exit(0);
  }
  // 用户偏好(2026-11-01 明确要求):**默认续跑**。逐措辞补信号是打地鼠——
  // 「我把通知栏收起后再装。」「看导航宿主怎么组织。」每次说法都不同,永远补不齐。
  // 翻转为:除非收尾明确属于「已完成/向用户提问/把决定权交回/复述长期规则」,
  // 一律续跑一轮(stop_hook_active 限每轮一次,防循环)。有工具的轮次同样适用
  // —— 「干完半截活就停」正是 post-tool 停止的主要形态。
  const verdict = detectStall(lastText, { toolCallCount: 0 });
  // 过短(加权 <14):只有命中完成态才放行,否则续跑——「修好了,测试通过。」放行,
  // 「首页出来了。」(工作中途)续跑。完成态判定留在守卫本地,不改 shared 的 MIN。
  if (verdict.verdict === 'too-short') {
    const doneish = /(?:修好|改好|写好|做完|弄好|完成|搞定|通过|跑通|绿了|收工)[。.!！]?\s*$/.test(lastText.trim());
    if (doneish) process.exit(0);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: FALLBACK_REASON }));
    process.exit(0);
  }
  const PASS_VERDICTS = ['already-done', 'question', 'asked-user', 'standing-rule'];
  if (!PASS_VERDICTS.includes(verdict.verdict)) {
    const reason = verdict.prompt ?? FALLBACK_REASON;
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  }
  process.exit(0);
} catch {
  process.exit(0); // 任何异常都静默放行:漏续跑的代价远小于错续跑
}
