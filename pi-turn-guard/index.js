/**
 * pi-turn-guard — 收尾前补一轮：空回合，以及没有自带守卫的 provider 的 stall。
 *
 * 为什么需要单独一个扩展：
 *
 * pi 上 trae / workbuddy / qoder 只是 `models.json` 里的普通 openai-completions
 * provider（指向 zcode 那套本地端点 39270/39271/39272），没有任何扩展替它们做
 * 收尾守卫；而 pi-provider-qwenwork 自带的守卫硬编码只认 `qwenwork`，扩散不到
 * 这三个。空回合（见下）更是谁都不管。
 *
 * 处理两类：
 *
 *  1. 空回合 —— 模型只留下 thinking，正文为空、也没调工具。用户看到的就是
 *     「思考着，突然不工作了」。对所有 provider 生效。
 *  2. stall —— 宣布了下一步却没动手。只对**没有自带守卫**的 provider 生效，
 *     否则会和 pi-provider-qwenwork 的守卫重复塞两条续跑提示。
 *
 * 全程 fail-open：拿不到上下文、解析出错、预算耗尽，都返回 undefined 让这一轮
 * 正常结束。宁可漏一次续跑，也不能把用户的回合卡住。
 *
 * @module pi-turn-guard
 */

import { detectStall, EMPTY_TURN_PROMPT } from './lib/stall-detector.mjs';

/** 同一条用户输入之后最多自动续跑几次。 */
export const MAX_AUTO_CONTINUES = 2;

/**
 * 自带 stall 守卫的 provider —— 它们的 stall 交给自己的扩展处理，这里只补空回合。
 * 空回合谁都没管，所以对包括它们在内的所有 provider 生效。
 */
const PROVIDERS_WITH_OWN_STALL_GUARD = new Set(['qwenwork']);

/** 从一条 assistant 消息里取出可见正文。 */
function visibleTextOf(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('');
}

export default function turnGuardExtension(pi) {
  let autoContinues = 0;

  // 用户说了新话就重新给预算 —— 续跑是替用户追着模型要结果，不是替模型发言。
  pi.on('input', () => {
    autoContinues = 0;
    return { action: 'continue' };
  });

  pi.on('agent_before_settle', (event) => {
    try {
      // 已经有别的守卫要求继续了，不抢。
      if (event?.continue) return undefined;
      // 用户中断 / 出错的回合不续跑 —— 这正是 dsh 0.2.1 修的那个坑。
      if (event?.outcome !== 'completed') return undefined;

      const last = event.context?.llmMessages?.at(-1);
      if (!last || last.role !== 'assistant') return undefined;
      if (last.stopReason !== 'stop') return undefined;
      if ((last.content ?? []).some((block) => block?.type === 'toolCall')) return undefined;

      const text = visibleTextOf(last);
      const provider = last.provider;

      let prompt = null;
      let kind = '';

      if (text.trim() === '') {
        prompt = EMPTY_TURN_PROMPT;
        kind = 'empty-turn';
      } else if (!PROVIDERS_WITH_OWN_STALL_GUARD.has(provider)) {
        const result = detectStall(text, { toolCallCount: 0 });
        if (result.stall && result.prompt) {
          prompt = result.prompt;
          kind = `stall(score=${result.score}, ${result.signals.join('+')})`;
        }
      }

      if (!prompt) return undefined;
      if (autoContinues >= MAX_AUTO_CONTINUES) {
        pi.logger?.info?.(`[pi-turn-guard] budget exhausted (${MAX_AUTO_CONTINUES}); leaving the turn alone`);
        return undefined;
      }

      autoContinues += 1;
      pi.logger?.info?.(
        `[pi-turn-guard] ${kind} on provider=${provider ?? 'unknown'}; asking for one more turn (${autoContinues}/${MAX_AUTO_CONTINUES})`,
      );

      return {
        entries: [
          ...(event.entries ?? []),
          {
            type: 'custom_message',
            customType: 'pi-turn-guard',
            content: prompt,
            display: true,
          },
        ],
        continue: true,
      };
    } catch (error) {
      pi.logger?.debug?.('[pi-turn-guard] skipped due to error', error);
      return undefined;
    }
  });
}
