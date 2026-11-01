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
import { detectStall } from '../shared/stall-detector.mjs';

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
        if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) lastText = p.text;
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
  if (!lastText) process.exit(0); // 纯工具轮/无文本,无可判内容

  const verdict = detectStall(lastText, { toolCallCount: toolCalls });
  if (verdict.stall && verdict.prompt) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.prompt }));
  }
  process.exit(0);
} catch {
  process.exit(0); // 任何异常都静默放行:漏续跑的代价远小于错续跑
}
