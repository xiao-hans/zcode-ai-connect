/**
 * stall-detector — 「宣布了下一步却没调用工具」的启发式判定。
 *
 * 权威源。改这里，然后跑 `node scripts/sync-stall-detector.mjs` 分发到各宿主：
 *   zcode-{trae,workbuddy,qoder,qwenwork}-connect/hooks/stall-detector.mjs
 *   ref/pi-provider-qwenwork/lib/stall-detector.js
 *   ref/dsh-qwen-connect/lib/stall-detector.js
 *
 * 设计约束（这是整个功能唯一的真风险点）：
 *
 *  1. 这是启发式，不是判定器。宁可漏掉一次续跑，也不要打断一条正常收尾的回复 ——
 *     误续跑会让模型把「已经做完的事」再做一遍，比不续跑更糟。
 *  2. 否决（veto）规则必须先于肯定（cue）规则求值：同一个句子里「请你确认后我
 *     再执行」既含请求也含未来时，「请求」永远胜出。
 *  3. 不能按「以冒号结尾」一刀切 —— 说明性文字大量以冒号收尾（「根因有三层：」），
 *     所以冒号只是加权项，且不足以独立触发。
 *  4. 零依赖、纯函数、无 IO：四个 ZCode 插件包、pi 扩展、dsh 插件各自打包一份，
 *     不能有任何跨包 import。
 *
 * @module stall-detector
 */

/** 上限：只看最后两块 + 最多 600 字符。更早的内容是背景，不是收尾意图。 */
const TAIL_BLOCK_COUNT = 2;
const TAIL_CHAR_LIMIT = 600;

/**
 * 低于这个（加权）长度的回复不判 —— 「好的。」「Done.」没有可续跑的动作。
 *
 * 中日韩文字按 1.6 字计权：同样表达一个完整动作，中文比英文短得多，
 * 用统一的字符数会把「我先检查配置，再修改这里：」这样明确的收尾拒之门外。
 */
const MIN_WEIGHTED_CHARS = 14;

/** 请求用户裁决 / 提供输入的措辞。命中即否决。 */
const REQUEST_PATTERNS = [
  // 中文：把决定权交回用户
  /请你?(?:确认|批准|授权|选择|决定|提供|粘贴|发送|告知|告诉)/,
  /你(?:可以|需要|来)(?:确认|决定|选择|提供|先)/,
  /需要你(?:确认|决定|操作|提供|回复|选择)/,
  /(?:是否|要不要|需不需要|要不要我|需要我)(?:继续|执行|我|帮|先|再)?/,
  /等你(?:确认|回复|决定|操作)/,
  /告诉我(?:你|是否|要|结果|选择)/,
  /让我知道/,
  /由你(?:决定|来|选)/,
  /你(?:先|来)(?:确认|决定|操作|选)/,
  /确认后(?:我)?再/,
  /(?:你|您)看(?:看|一下)?(?:是否|要不要|行不行)/,
  // English: handing the decision back
  /\blet me know\b/i,
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\bshall i\b/i,
  /\bplease (?:confirm|advise|provide|choose)\b/i,
  /\byour call\b/i,
  /\bwhich (?:one|option|approach) (?:do you|would you)\b/i,
  /\bcan you (?:confirm|provide|share|tell)\b/i,
  /\bwaiting (?:for|on) your\b/i,
];

/** 「已经做完」的收尾。命中且无未来标记时否决。 */
const DONE_PATTERNS = [
  /(?:已|已经)(?:经)?(?:完成|修好|改好|搞定|处理完|就绪|生效|上线|发布|通过)/,
  /(?:全部|都)(?:完成|通过|搞定|就绪)/,
  /(?:搞定|收工|完事)(?:了)?[。.!！]?$/,
  /(?:到|就)这里(?:为止|结束)?/,
  /(?:没有|无需)(?:其他|更多|别的)(?:改动|问题|需要)/,
  /\b(?:all )?done\b/i,
  /\b(?:finished|completed|ready to go)\b/i,
  /\bnothing (?:else|more) (?:to do|needed)\b/i,
  /\ball (?:tests? )?pass(?:ed|ing)?\b/i,
];

/** 强未来标记：明确宣布「我即将做」。单独出现即高置信。 */
const FUTURE_STRONG = [
  // 「我先…」「我这就…」是中文里最典型的「宣布即将动手」，不必再跟动词。
  /我(?:先|这就|马上|立刻|接下来|现在)/,
  /我(?:来|将|会|要|去)(?:先|先来)?/,
  /先让我/,
  /让(?:我们|我)先/,
  /(?:接下来|下面|现在)我(?:来|将|会|要)/,
  /开始(?:执行|处理|修改|实现|写|改|跑|检查)/,
  /\blet me\b/i,
  /\bi'?ll\b/i,
  /\bi will\b/i,
  /\bi'?m going to\b/i,
  /\bnow i'?ll\b/i,
  /\blet'?s\b/i,
];

/** 弱未来标记：推进语，但单独不足以说明「要动手」 —— 也可能是继续讲解。 */
const FUTURE_WEAK = [
  /接下来/,
  /下一步/,
  /下面(?:我|我们)?/,
  /然后(?:我|我们)?/,
  /首先/,
  /现在(?:我|我们)?/,
  /\bnext,?\b/i,
];

/** 动作动词：把「未来时」落到「要做一件具体的事」上。 */
const ACTION_VERB = [
  /(?:检查|查看|看看|查一下|读取|打开|搜索|定位)/,
  /(?:修改|改成|改掉|编辑|写入|创建|新建|删除|移除|重写)/,
  /(?:执行|运行|跑一下|启动|重启|安装|部署|发布|提交)/,
  /(?:修复|实现|添加|增加|补充|更新|替换|迁移|重构)/,
  /(?:验证|测试|校验|确认一下|跑通|编译)/,
  /\b(?:check|read|open|inspect|look at|search|grep)\b/i,
  /\b(?:edit|write|create|add|remove|delete|rewrite|patch|update)\b/i,
  /\b(?:run|execute|install|deploy|build|start|restart|publish)\b/i,
  /\b(?:fix|implement|refactor|migrate|verify|test)\b/i,
];

/** 尾部形态加权。冒号不足以独立触发，见文件头第 3 条。 */
const COLON_TAIL = /[:：]\s*$/;
const ELLIPSIS_TAIL = /(?:\.{3,}|…)\s*$/;

/** 阈值。只有弱未来标记时必须靠额外信号才能过线。 */
const THRESHOLD_STRONG = 3;
const THRESHOLD_WEAK_ONLY = 4.5;

/** 去掉代码围栏/行内代码/标签 —— 代码里的冒号和动词不是模型的收尾意图。 */
function stripNoise(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]{0,200}>/g, ' ')
    .replace(/\[[^\]]{0,80}\]\([^)]{0,300}\)/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 最后两块非空段落，按字符上限截尾。 */
function tailOf(text) {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 0) return '';
  const joined = blocks.slice(-TAIL_BLOCK_COUNT).join('\n').trim();
  return joined.length > TAIL_CHAR_LIMIT ? joined.slice(-TAIL_CHAR_LIMIT) : joined;
}

/** @returns {boolean} */
function anyMatch(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/** 中日韩字符按 1.6 计权后的长度，见 MIN_WEIGHTED_CHARS。 */
function weightedLength(text) {
  let total = 0;
  for (const ch of text) {
    total += /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch) ? 1.6 : 1;
  }
  return total;
}

/**
 * 判定一条 assistant 收尾文本是否「宣布了下一步却没动手」。
 *
 * @param {string} rawText            assistant 的最后一条消息文本
 * @param {{ toolCallCount?: number }} [options]
 *   toolCallCount > 0 一律不判 —— 已经有工具调用的轮次不存在「只说不做」。
 * @returns {{
 *   stall: boolean,
 *   verdict: 'stall' | 'had-tools' | 'too-short' | 'empty' | 'question' | 'asked-user'
 *          | 'already-done' | 'no-future-cue' | 'weak-only',
 *   score: number,
 *   signals: string[],
 *   prompt: string | null,
 * }}
 */
export function detectStall(rawText, options = {}) {
  const toolCallCount = Number.isFinite(options.toolCallCount) ? options.toolCallCount : 0;
  const empty = { stall: false, score: 0, signals: [], prompt: null };

  if (toolCallCount > 0) return { ...empty, verdict: 'had-tools' };

  const raw = String(rawText ?? '').trim();
  if (raw === '') return { ...empty, verdict: 'empty' };

  const text = stripNoise(raw);
  if (weightedLength(text) < MIN_WEIGHTED_CHARS) return { ...empty, verdict: 'too-short' };

  const tail = tailOf(text);
  const trimmedRaw = raw.trim();

  // ── 否决 ①：以问句收尾 ────────────────────────────────────────────────────
  // 模型在提问时同样会「不调工具就停」，那是在等用户，不是漏执行。
  if (/[?？]\s*$/.test(trimmedRaw)) return { ...empty, verdict: 'question' };

  // ── 否决 ②：把决定权交回用户 ─────────────────────────────────────────────
  if (anyMatch(REQUEST_PATTERNS, tail)) return { ...empty, verdict: 'asked-user' };

  const hasStrongFuture = anyMatch(FUTURE_STRONG, tail);
  const hasWeakFuture = anyMatch(FUTURE_WEAK, tail);

  // ── 否决 ③：明确宣告完成且没有未来时 ─────────────────────────────────────
  if (!hasStrongFuture && !hasWeakFuture && anyMatch(DONE_PATTERNS, tail)) {
    return { ...empty, verdict: 'already-done' };
  }

  // ── 打分 ─────────────────────────────────────────────────────────────────
  let score = 0;
  const signals = [];

  if (hasStrongFuture) {
    score += 2;
    signals.push('future-strong');
  }
  if (hasWeakFuture) {
    score += 1.5;
    signals.push('future-weak');
  }
  if (anyMatch(ACTION_VERB, tail)) {
    score += 1;
    signals.push('action-verb');
  }
  if (COLON_TAIL.test(trimmedRaw)) {
    score += 1.5;
    signals.push('colon-tail');
  }
  if (ELLIPSIS_TAIL.test(trimmedRaw)) {
    score += 0.5;
    signals.push('ellipsis-tail');
  }

  if (!hasStrongFuture && !hasWeakFuture) {
    return { stall: false, verdict: 'no-future-cue', score, signals, prompt: null };
  }

  const threshold = hasStrongFuture ? THRESHOLD_STRONG : THRESHOLD_WEAK_ONLY;
  if (score < threshold) {
    return { stall: false, verdict: 'weak-only', score, signals, prompt: null };
  }

  return { stall: true, verdict: 'stall', score, signals, prompt: CONTINUE_PROMPT };
}

/**
 * 回灌给模型的续跑提示。
 *
 * 刻意不命令「继续」，而是给出三个出口：执行 / 说明为何不需要执行 / 提出具体问题。
 * 只写「继续」会让模型重复一遍刚才那段计划。
 */
export const CONTINUE_PROMPT = [
  '你上一条回复宣布了下一步操作（例如「我先…」「接下来…」「Let me…」），但没有调用任何工具就结束了这一轮。',
  '请直接执行这个操作。',
  '如果它其实已经完成，或不需要执行，用一句话说明结论即可，不要重述计划。',
  '如果需要用户先决定，提出一个具体的问题，不要继续描述待办。',
].join('\n');

export default detectStall;
