#!/usr/bin/env node
/**
 * claude-stall-guard.mjs — Claude Code Stop hook:模型「宣布了下一步却直接停住」
 * /「只回了个『继续』」/「只留思考不说话」时,自动续跑一轮。
 *
 * 判定与 ZCode/pi/dsh/hermes 四个宿主共用同一套 shared/stall-detector.mjs
 * (test-detector-parity.mjs 保证 JS/Python 两实现一致);本文件只做 Claude 的 IO。
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
 *   3. 同一段回复文本只续跑一次(跨进程原子指纹锁,默认 ~/.claude-stall-guard/)。
 *   4. 同一回合最多续跑 MAX_AUTO_CONTINUES 次。
 *
 * 为什么不能只靠 stop_hook_active:它是「本轮已经续跑过」的布尔量,一次到手就
 * 永久为真,于是**一轮只能救一次** —— 长任务里模型换句话再说一遍「我先改…」
 * 就再也兜不住了。实测(2026-11-01,会话 45cdd3d3)同一轮里出现多次独立停住,
 * 只有第 1 次被救。这里改成「文本指纹去重 + 每回合预算」,与 ZCode 侧同一套
 * 机制,把最坏情况钉死在 MAX_AUTO_CONTINUES 次。
 *
 * 轮次起点判定:从尾部回溯,最近一条「真人输入」(content 非纯 tool_result、
 * 且不是 isMeta 注入)的 user 条目为本轮起点 —— tool_result 条目是工具回传,
 * isMeta 条目是宿主注入的合成消息,两者都属于轮内。
 */
import { readFileSync, mkdirSync, openSync, closeSync, writeSync, readdirSync, statSync, unlinkSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectStall, EMPTY_TURN_PROMPT } from '../shared/stall-detector.mjs';

/**
 * 续跑提示。刻意短:这是回灌给模型的一条 user 消息,写得越长越容易被弱模型当成
 * 正文复述(实测 2026-11-01 会话 56720125,trae/deepseek-v4.1-flash 把整段提示
 * 抄进了自己的回复,于是又一轮"停住")。
 */
const FALLBACK_REASON = [
  '继续执行:直接调用工具把剩下的步骤做完。',
  '不要复述本条消息,也不要把它当作任务内容。',
  '确实做完了就用一句话说明结论。',
].join('\n');

/**
 * 同一回合最多自动续跑几次。
 *
 * 从 3 提到 6 的依据(2026-11-01 会话 8d662da8 全量统计):trae/deepseek-v4.1-flash
 * 的空收尾率 8.1%(6/74),wb/deepseek-v4.1-flash 2.0%(16/796)。长任务里一轮
 * 用户输入会跑几十个工具轮,8% 意味着平均每轮都要撞一两次;3 次预算在长任务上
 * 不够用,用完就只能眼看着停在半路。去重仍按「同一回合 + 同一段文本」,所以
 * 真正的死循环(模型反复说同一句话)依然只救一次。
 */
const MAX_AUTO_CONTINUES = 6;
const SIGNATURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_HOME = process.env['ZCLAUDE_STALL_GUARD_HOME'] ?? join(homedir(), '.claude-stall-guard');
const LOG_PATH = join(LOCK_HOME, 'guard.log');

/**
 * 诊断日志只写文件,不写 stderr。
 *
 * 原先按「stdout 纯 JSON、日志走 stderr」的老规矩办,但 Claude Code 会把这类
 * 阻塞型 hook 的 stderr 一并以 "Stop hook blocking error from command: …" 的
 * 形式塞回上下文 —— 模型看见一段陌生文本,弱模型(实测 trae 的 flash 档)会直接
 * 把它当成正文复述。诊断信息不值得污染上下文。
 */
function log(message) {
  try {
    mkdirSync(LOCK_HOME, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch { /* 诊断尽力而为,绝不影响 hook 结果 */ }
}

function hashKey(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 20);
}

/** 原子占位:只有第一个创建成功的进程拿到 true(`wx` 在 Windows/POSIX 都原子)。 */
function tryClaim(name) {
  try {
    mkdirSync(LOCK_HOME, { recursive: true });
    const fd = openSync(join(LOCK_HOME, name), 'wx');
    try { writeSync(fd, `${new Date().toISOString()}\n`); } finally { closeSync(fd); }
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') log(`claim failed: ${String(error?.message ?? error)}`);
    return false;
  }
}

/** 领取本回合第几个续跑名额(1-based);0 = 预算耗尽。 */
function claimTurnBudget(turnKey, max) {
  for (let attempt = 1; attempt <= max; attempt += 1) {
    if (tryClaim(`budget-${turnKey}-${attempt}`)) return attempt;
  }
  return 0;
}

function pruneOldSignatures() {
  try {
    const now = Date.now();
    for (const entry of readdirSync(LOCK_HOME)) {
      try {
        if (now - statSync(join(LOCK_HOME, entry)).mtimeMs > SIGNATURE_TTL_MS) unlinkSync(join(LOCK_HOME, entry));
      } catch { /* 并发占用,下轮再说 */ }
    }
  } catch { /* 目录还不存在 */ }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function isToolResult(content) {
  return Array.isArray(content) && content.length > 0 && content.every(p => p && p.type === 'tool_result');
}

/**
 * 本轮统计:最后一条 assistant 文本、本轮工具调用数、本轮起点(真人输入)文本。
 * @returns {{toolCalls:number, lastText:string, turnStart:string}}
 */
function lastTurnStats(entries) {
  let toolCalls = 0;
  let lastText = '';
  let turnStart = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const o = entries[i];
    if (o.type === 'user' && o.message?.content !== undefined) {
      const c = o.message.content;
      if (!isToolResult(c)) {
        // isMeta 是宿主注入的合成消息(Stop hook feedback / 系统提示),不是真人输入
        if (!o.isMeta) {
          turnStart = typeof c === 'string'
            ? c
            : (Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text ?? '').join('') : '');
          break; // 本轮起点(真人输入)
        }
        continue; // 注入消息不打断回溯
      }
    }
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const p of o.message.content) {
        if (p?.type === 'tool_use') toolCalls++;
        // 逆序回溯:第一条找到的文本就是时间上最末的 assistant 文本,不可被更早的覆盖
        if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim() && !lastText) lastText = p.text;
      }
    }
  }
  return { toolCalls, lastText, turnStart };
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw); } catch { return; }
  if (!event.transcript_path) return;

  let lines;
  try {
    lines = readFileSync(event.transcript_path, 'utf8').trim().split('\n');
  } catch (error) {
    log(`transcript unreadable: ${String(error?.message ?? error)}`);
    return;
  }
  const entries = lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && (o.type === 'assistant' || o.type === 'user'));
  if (!entries.length) return;

  const { toolCalls, lastText, turnStart } = lastTurnStats(entries);
  const sessionId = typeof event.session_id === 'string' && event.session_id ? event.session_id : 'unknown';
  const turnKey = hashKey(sessionId, turnStart.slice(0, 400));

  let reason = null;
  if (!lastText) {
    // 纯思考 / 空消息收尾:一轮的最后一个 assistant 消息一个字符都没有,这从来不是
    // 合法的收尾(要么模型只思考了、要么正文被上游丢了)。**不再要求本轮零工具调用**
    // —— 长任务里几乎每一轮都有工具调用,那个条件会让这类空收尾整类漏掉
    // (实测 #7397:轮内已有 4 次工具调用,末条消息内容为空,无人兜)。
    reason = EMPTY_TURN_PROMPT;
  } else {
    // 用户偏好(2026-11-01 明确要求):**默认续跑**。逐措辞补信号是打地鼠 ——
    // 每次说法都不同,永远补不齐。翻转为:除非收尾明确属于「已完成/向用户提问/
    // 把决定权交回/复述长期规则」,一律续跑一轮。有工具的轮次同样适用 ——
    // 「干完半截活就停」正是 post-tool 停止的主要形态。
    const verdict = detectStall(lastText, { toolCallCount: 0 });
    if (verdict.verdict === 'too-short') {
      // 过短(加权 <14):只有命中完成态或问句才放行——「修好了,测试通过。」放行,
      // 「首页出来了。」(工作中途)续跑。完成态/问句判定留在守卫本地,不改 shared 的 MIN。
      // 问句必须在这里判:detectStall 的长度闸门排在否决规则之前,「要我接着做哪条？」
      // 只有 8 个字,过不了 MIN,拿不到 question 裁决,会被误续跑。
      const tail = lastText.trim();
      const doneish = /(?:修好|改好|写好|做完|弄好|完成|搞定|通过|跑通|绿了|收工)[。.!！]?\s*$/.test(tail);
      const isQuestion = /[?？]\s*$/.test(tail);
      if (!doneish && !isQuestion) reason = FALLBACK_REASON;
    } else {
      const PASS_VERDICTS = ['already-done', 'question', 'asked-user', 'standing-rule'];
      if (!PASS_VERDICTS.includes(verdict.verdict)) reason = verdict.prompt ?? FALLBACK_REASON;
    }
  }

  if (!reason) return;

  // 先去重再领名额:同一回合内同一段文本只会救一次;换句话再中才算新的一次停住。
  // 指纹里必须带 turnKey —— 只按 session+文本去重的话,「我先看一下。」这种套话
  // 在本会话里第二次出现就永远不救了(空文本更是全session共用一个键)。
  if (!tryClaim(`text-${hashKey(turnKey, lastText)}`)) {
    log('same reply already continued once; leaving it alone');
    return;
  }
  const attempt = claimTurnBudget(turnKey, MAX_AUTO_CONTINUES);
  if (attempt === 0) {
    log(`auto-continue budget exhausted for this turn (${MAX_AUTO_CONTINUES})`);
    return;
  }
  pruneOldSignatures();
  log(`stall → continue (${attempt}/${MAX_AUTO_CONTINUES})`);
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

main()
  .catch(error => log(`unexpected: ${String(error?.message ?? error)}`))
  .finally(() => {
    // exit 2 对 Stop 意味着「要求继续」,任何情况下都正常退出。
    process.exit(0);
  });
