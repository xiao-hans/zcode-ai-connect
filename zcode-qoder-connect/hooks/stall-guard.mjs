#!/usr/bin/env node
/**
 * Stop hook: 模型「宣布了下一步却直接停住」时，让 ZCode 再跑一轮。
 *
 * 触发条件由 ZCode 保证 —— Stop hook 只在一轮**没有任何工具调用**时执行，
 * 所以这里不必判断「有没有动手」，只需要判断「这段话是不是在宣布要动手」。
 * 判定逻辑在 ./stall-detector.mjs，本文件只负责 IO、去重与预算。
 *
 * 输出契约（D:\zcode\resources\glm\zcode.cjs 的 processHookOutput）：
 *   {"decision":"block","reason":"…"}  → stopShouldContinue，reason 回灌上下文
 *   什么都别输出（或输出 {}）            → 正常结束这一轮
 *
 * 四条不能违反的规则：
 *   1. **stdout 只能是纯 JSON**。ZCode 对整段 stdout 做 JSON.parse，任何一行
 *      console.log 都会让整次输出作废。日志一律写 stderr。
 *   2. **绝不用 exit 2 表示出错**。对 Stop 事件，exit 2 等价于
 *      {"decision":"block","reason":<stderr>}，会把错误信息当成续跑指令。
 *      所有异常路径都 exit 0。
 *   3. **同一段回复只续跑一次**。四个连接器插件都会注册这个 hook（用户装几
 *      个就注册几份），ZCode 会全部执行并合并结果；不去重就会把同一条提示
 *      塞四遍。这里用原子创建指纹锁实现跨进程互斥。
 *   4. **同一回合最多续跑 MAX_AUTO_CONTINUES 次**。模型可能每轮都「宣布下一
 *      步却停住」，光靠「相同文本去重」挡不住 —— 换个说法就会再中一次，于是
 *      无限续跑。预算按 turnId 计数，新回合自动重置。这一条同时也是 ZCode 侧
 *      能做的最接近上游「不抢在用户停止之前」的保护：Stop hook 是独立进程、
 *      看不到宿主是否已被用户中断，只能靠预算把最坏情况钉死在 2 次。
 *
 * @module zcode-*-connect/hooks/stall-guard
 */

import { openSync, closeSync, writeSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectStall, EMPTY_TURN_PROMPT } from './stall-detector.mjs';

/** 四个包共用同一把锁，否则「装几个插件就续跑几次」。 */
const LOCK_HOME = process.env['ZCODE_STALL_GUARD_HOME'] ?? join(homedir(), '.zcode-stall-guard');
const SIGNATURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 同一回合（turnId）内最多自动续跑几次，与 pi / dsh 侧 MAX_AUTO_CONTINUES 对齐。 */
const MAX_AUTO_CONTINUES = 2;

const pluginName = (() => {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url))).split(/[\\/]/).pop() ?? 'zcode-connect';
  } catch {
    return 'zcode-connect';
  }
})();

function log(message) {
  try {
    process.stderr.write(`[${pluginName}/stall-guard] ${message}\n`);
  } catch {
    // stderr 写不进去也不能影响 hook 结果。
  }
}

/** stdout 只能出现这一个函数写出的内容。 */
function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function hashKey(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 20);
}

/**
 * 原子占位：只有第一个创建成功的进程返回 true。
 *
 * `wx` 打开在 Windows 与 POSIX 上都是原子的 —— 四个 hook 进程同时到达时，
 * 内核只会让一个拿到 fd。
 */
function tryClaim(name) {
  try {
    mkdirSync(LOCK_HOME, { recursive: true });
    const fd = openSync(join(LOCK_HOME, name), 'wx');
    try {
      writeSync(fd, `${new Date().toISOString()}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    // EEXIST = 兄弟插件/上一轮已经占位；其它错误（无权限等）按「不续跑」处理，
    // 因为重复一条续跑提示比漏掉一次更糟。
    if (error?.code !== 'EEXIST') log(`claim failed: ${String(error?.message ?? error)}`);
    return false;
  }
}

/**
 * 领取本回合的续跑名额，返回第几次（1-based）；0 表示预算已耗尽。
 *
 * 名额本身就是一个原子创建的文件，所以并发安全：四个插件同时到达时也只有
 * 一个能拿到 `budget-<turn>-1`。
 */
function claimTurnBudget(turnKey, max) {
  for (let attempt = 1; attempt <= max; attempt += 1) {
    if (tryClaim(`budget-${turnKey}-${attempt}`)) return attempt;
  }
  return 0;
}

/** 顺手清掉过期指纹，避免目录无限增长。失败不影响主流程。 */
function pruneOldSignatures() {
  try {
    const now = Date.now();
    for (const entry of readdirSync(LOCK_HOME)) {
      const path = join(LOCK_HOME, entry);
      try {
        if (now - statSync(path).mtimeMs > SIGNATURE_TTL_MS) unlinkSync(path);
      } catch {
        // 并发删除/占用 —— 下一轮再说。
      }
    }
  } catch {
    // 目录还不存在。
  }
}

/** 取第一个非空字符串字段（ZCode 的 payload 同时带 camelCase 与 snake_case）。 */
function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

async function main() {
  const raw = await readStdin();
  if (raw.trim() === '') return emit({});

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    log('stdin was not JSON; ignoring');
    return emit({});
  }

  // ZCode 把整段回复放在 responseText；last_assistant_message 是兼容 Claude Code
  // 的别名，两个都在时优先后者（它对未完成的流更保守）。
  const text = typeof input['last_assistant_message'] === 'string' && input['last_assistant_message'].trim() !== ''
    ? input['last_assistant_message']
    : typeof input['responseText'] === 'string'
      ? input['responseText']
      : '';

  const toolCallCount = Number.isFinite(input['toolCallCount']) ? input['toolCallCount'] : 0;
  const sessionId = pickString(input, ['session_id', 'sessionId']) || 'unknown';
  // turnId 缺失时退化为按会话计数 —— 比不设预算安全，但不如按回合精确。
  const turnId = pickString(input, ['turnId', 'turn_id']) || `session:${sessionId}`;

  const result = detectStall(text, { toolCallCount });

  // 空回合：模型只留下 thinking，既没有正文也没有工具调用就收尾了。
  // detectStall 对空文本返回 'empty'（不续跑），但那正是用户看到「思考着突然
  // 不工作」的场景 —— 这里单独识别并续跑，提示语也不同（没有可判断的意图，
  // 只能要求它把结论说出来）。
  const emptyTurn = !result.stall && text.trim() === '' && toolCallCount === 0;

  if (!result.stall && !emptyTurn) {
    log(`no stall (${result.verdict}, score=${result.score})`);
    return emit({});
  }

  // 先去重再领名额：兄弟插件并发时只有一个进程能走到领名额这一步，
  // 否则四个进程会把 2 个名额一次抢光。
  if (!tryClaim(`text-${hashKey(turnId, text)}`)) {
    log(`stall already handled in this turn (score=${result.score})`);
    return emit({});
  }

  const attempt = claimTurnBudget(hashKey(turnId), MAX_AUTO_CONTINUES);
  if (attempt === 0) {
    log(`auto-continue budget exhausted for this turn (${MAX_AUTO_CONTINUES}); leaving the turn alone`);
    return emit({});
  }

  pruneOldSignatures();
  // decision:block 必须带 reason，否则 additionalContexts 为空、不会续跑。
  if (emptyTurn) {
    log(`empty turn (only thinking, no text, no tools) → asking for one more turn (${attempt}/${MAX_AUTO_CONTINUES})`);
    return emit({ decision: 'block', reason: EMPTY_TURN_PROMPT });
  }
  log(`stall detected (score=${result.score}, signals=${result.signals.join('+')}) → asking for one more turn (${attempt}/${MAX_AUTO_CONTINUES})`);
  return emit({ decision: 'block', reason: result.prompt });
}

main()
  .catch((error) => log(`unexpected: ${String(error?.message ?? error)}`))
  .finally(() => {
    // exit 2 对 Stop 意味着「要求继续」，所以任何情况下都正常退出。
    process.exit(0);
  });
