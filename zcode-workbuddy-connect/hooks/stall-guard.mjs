#!/usr/bin/env node
/**
 * Stop hook: 模型「宣布了下一步却直接停住」时，让 ZCode 再跑一轮。
 *
 * 触发条件由 ZCode 保证 —— Stop hook 只在一轮**没有任何工具调用**时执行，
 * 所以这里不必判断「有没有动手」，只需要判断「这段话是不是在宣布要动手」。
 * 判定逻辑在 ./stall-detector.mjs，本文件只负责 IO 与去重。
 *
 * 输出契约（D:\zcode\resources\glm\zcode.cjs 的 processHookOutput）：
 *   {"decision":"block","reason":"…"}  → stopShouldContinue，reason 回灌上下文
 *   什么都别输出（或输出 {}）            → 正常结束这一轮
 *
 * 三条不能违反的规则：
 *   1. **stdout 只能是纯 JSON**。ZCode 对整段 stdout 做 JSON.parse，任何一行
 *      console.log 都会让整次输出作废。日志一律写 stderr。
 *   2. **绝不用 exit 2 表示出错**。对 Stop 事件，exit 2 等价于
 *      {"decision":"block","reason":<stderr>}，会把错误信息当成续跑指令。
 *      所有异常路径都 exit 0。
 *   3. **同一段回复只续跑一次**。四个连接器插件都会注册这个 hook（用户装几
 *      个就注册几份），ZCode 会全部执行并合并结果；不去重就会把同一条提示
 *      塞四遍。这里用原子创建指纹锁实现跨进程互斥。
 *
 * @module zcode-*-connect/hooks/stall-guard
 */

import { openSync, closeSync, writeSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectStall } from './stall-detector.mjs';

/** 四个包共用同一把锁，否则「装几个插件就续跑几次」。 */
const LOCK_HOME = process.env['ZCODE_STALL_GUARD_HOME'] ?? join(homedir(), '.zcode-stall-guard');
const SIGNATURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * 原子占位：只有第一个创建成功的进程返回 true。
 *
 * `wx` 打开在 Windows 与 POSIX 上都是原子的 —— 四个 hook 进程同时到达时，
 * 内核只会让一个拿到 fd。
 */
function claimSignature(sessionId, text) {
  const digest = createHash('sha256')
    .update(`${sessionId}\u0000${text}`)
    .digest('hex')
    .slice(0, 20);
  try {
    mkdirSync(LOCK_HOME, { recursive: true });
    const path = join(LOCK_HOME, digest);
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, `${new Date().toISOString()} ${sessionId}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    // EEXIST = 兄弟插件已经处理过这条回复；其它错误（无权限等）按「不续跑」处理，
    // 因为 duplicating 一条续跑提示比漏掉一次更糟。
    if (error?.code !== 'EEXIST') log(`claim failed: ${String(error?.message ?? error)}`);
    return false;
  }
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
  const sessionId = typeof input['session_id'] === 'string' ? input['session_id'] : 'unknown';

  const result = detectStall(text, { toolCallCount });
  if (!result.stall) {
    log(`no stall (${result.verdict}, score=${result.score})`);
    return emit({});
  }

  if (!claimSignature(sessionId, text)) {
    log(`stall already handled by a sibling plugin (score=${result.score})`);
    return emit({});
  }

  pruneOldSignatures();
  log(`stall detected (score=${result.score}, signals=${result.signals.join('+')}) → asking for one more turn`);
  // decision:block 必须带 reason，否则 additionalContexts 为空、不会续跑。
  return emit({ decision: 'block', reason: result.prompt });
}

main()
  .catch((error) => log(`unexpected: ${String(error?.message ?? error)}`))
  .finally(() => {
    // exit 2 对 Stop 意味着「要求继续」，所以任何情况下都正常退出。
    process.exit(0);
  });
