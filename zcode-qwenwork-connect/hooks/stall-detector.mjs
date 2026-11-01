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
  /请你?(?:确认|批准|授权|选择|决定|提供|粘贴|发送|告知|告诉|现在|立刻|马上|配合|扫码|扫|在)/,
  /你(?:可以|需要|来)(?:确认|决定|选择|提供|先)/,
  /需要你(?:确认|决定|操作|提供|回复|选择)/,
  // 「是否」裸出现**不算**把决定权交回用户：中文技术叙述里遍地都是
  // 「确认是否已引用」「验证是否不再崩溃」，那是模型自己的待办，不是提问。
  // 实测（2026-11-01，dengying 会话 45cdd3d3 / 8d662da8，trae/deepseek-v4.1-flash）：
  // 「安装成功。现在启动应用，验证是否不再崩溃。」「…我先确认 ui 是否已经引用。」
  // 两条都是宣布下一步后零工具调用就停，却因裸「是否」被判 asked-user 放行。
  // 只有把主语明确落在「我」或第二人称上才是否决。
  /(?:要不要|需不需要|是否要|是否需要)我(?:继续|执行|帮|先|再|来|做)?/,
  /(?:你|您)(?:是否|要不要|需不需要)/,
  /等你(?:确认|回复|决定|操作|安排)/,
  /告诉我(?:你|是否|要|结果|选择|一声|什么时候)/,
  /(?:说|吱|喊)一声/,
  /你(?:点个?头|说[「“"']?开[」”"']?)(?:我就|我立刻|我马上)?/,
  /要我[^。！？\n]{0,24}(?:就|的话|吗)/,
  /扫完(?:不用回复|告诉我|说一声)/,
  /让我知道/,
  /由你(?:决定|来|选|定)/,
  /你(?:先|来)(?:确认|决定|操作|选|说)/,
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

/**
 * 确认/复述长期规则或未来条件约定（「以后遇到…我会先…」「可以，主人。以后…」）。
 * 这是回答用户的规则设定，不是当前回合宣布下一步动作后漏调工具。
 */
const STANDING_RULE_PATTERNS = [
  /(?:以后|今后|之后|下次|后续|往后|接下来每次|每当|每次)[^。！？\n]{0,40}(?:提到|遇到|收到|让我|你让我|要求|需要|开始|做|时|的时候)[^。！？\n]{0,30}我(?:会|将|都会|先|就)/,
  /^(?:可以|好的?|明白|没问题|收到|记下了|知道了)[，,。！!\s]*(?:主人|小主|老板)?[，,。！!\s]*(?:以后|今后|之后|下次|后续|往后|每当|每次)/,
];

/** 「已经做完」的收尾。命中且无未来标记时否决。 */
const DONE_PATTERNS = [
  /(?:已|已经)(?:经)?(?:完成|修好|改好|搞定|处理完|就绪|生效|上线|发布|通过)/,
  /(?:全部|都)(?:完成|通过|搞定|就绪|闭合)/,
  /(?:搞定|收工|完事|可以收尾)(?:了)?[。.!！]?$/,
  /(?:到|就)这里(?:为止|结束)?/,
  /(?:没有|无需)(?:其他|更多|别的)(?:改动|问题|需要)/,
  /\b(?:all )?done\b/i,
  /\b(?:finished|completed|ready to go)\b/i,
  /\bnothing (?:else|more) (?:to do|needed)\b/i,
  /\ball (?:tests? )?pass(?:ed|ing)?\b/i,
  /(?:修好|改好|写好|做完|弄好)(?:了)?[。.!！]?\s*$/,
  /(?:测试|检验)(?:全部)?(?:通过|跑通|绿了)[。.!！]?\s*$/,
];

/**
 * 待办陈述：末尾声明存在未完成的工作（「…需要修。」「…还没验证。」）——
 * 没有任何「接下来/我先」式时间性措辞，旧信号集全部漏过。
 *
 * 实测（2026-11-01，dengying 会话 45cdd3d3，trae/deepseek-v4.1-flash）：
 * 模型干完半截活后以「diff 显示…原 KDoc 变成了…反而没有文档了。需要修。」
 * 收尾 —— pending-work 单独即可触发（强类，权重与 future-strong 相同）。
 *
 * 刻意要求动词紧贴尾标点：「需要修改才能生效。」的尾部是「生效」，不命中 ——
 * 那是在描述条件，不是宣布待办。按设计原则第 1 条，宁可漏掉也不能把
 * 说明性文字当成漏执行。
 */
const PENDING_WORK = [
  /需要(?:修复|修改|调整|处理|完善|重构|重写|迁移|补(?:上|充)?|修|改)[。.!！]?\s*$/,
  /(?:还差|还缺|还没)(?:修|改|处理|完成|做完|验证|跑|补|迁移)[^。！？\n]{0,16}[。.!！]?\s*$/,
  /(?:待|尚未)(?:修复|修改|处理|完成|验证|完善|补|迁移)[。.!！]?\s*$/,
  /(?:需要|得)再?(?:跑|过|走)(?:一遍|一次)?[^。！？\n]{0,16}[。.!！]?\s*$/,
  /\b(?:needs?|requires?)\s+(?:to\s+be\s+)?(?:fix|repair|adjust|handl\w*|rewrit\w*|refactor\w*|migrat\w*)\w*[.!?]?\s*$/i,
];

/** 强未来标记：明确宣布「我即将做」。单独出现即高置信。 */
const FUTURE_STRONG = [
  // 「我先…」「我这就…」是中文里最典型的「宣布即将动手」，不必再跟动词。
  /我(?:先|这就|马上|立刻|接下来|现在)/,
  /我(?:来|将|会|要|去)(?:先|先来)?/,
  // 「我查一下…」「我看一下…」：第一人称 + 具体动作 + 量词，等同于宣布马上动手。
  // 刻意要求量词 —— 单独的「我看」是表态（「我看行」），不是动作，不能算强信号。
  /我(?:查|看|确认|核对|验证|测试|跑|试|改|写|读|安装|重启|整理|搜索|定位|排查|梳理|对比|修)(?:一下|一遍|下|一把)/,
  /先让我/,
  /让(?:我们|我)先/,
  /(?:接下来|下面|现在)我(?:来|将|会|要)/,
  /开始(?:执行|处理|修改|实现|写|改|跑|检查)/,
  /(?:^|[。！？\n]\s*)(?:开始[。，,\s]*)?先(?:把|将|从|去|给|对|用|跑|看|查|改|写|读|登记|核对|整理|创建|执行|检查)[^。！？\n]{1,60}再/,
  /(?:^|[。！？\n]\s*)现在(?:重新|开始|把|将|先|去|来|给|对|跑|开|改|写|整理|执行|检查)/,
  // 把字句祈使式宣布:「把分类名从 A 传给 B,再传给 C。」—— 无「我先/接下来」
  // 措辞,但句首「把 + 对象 + 传递/落位动词」是标准的行动计划句式。
  // 实测(2026-11-01,dengying 会话 45cdd3d3):「把分类名从 IndexScreen 传给
  // VideoGrid,再传给 RankingRow。」旧信号集全部漏过。
  /(?:^|[。！？\n]\s*)把[^。！？\n]{1,60}(?:传给|传进|传到|写入|写进|加到|加进|插到|插进|接到|接上|连到|连进|迁到|迁进|改成|改为|换成|塞进|递给|交给|移入)[^。！？\n]{0,40}/,
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
  /(?:检查|查看|看看|查一下|读取|打开|搜索|定位|核对|登记|整理)/,
  /(?:修改|改成|改掉|编辑|写入|创建|新建|删除|移除|重写|写进)/,
  /(?:执行|运行|跑一下|跑起|启动|重启|安装|部署|发布|提交|开窗口|重新开)/,
  /(?:修复|实现|添加|增加|补充|更新|替换|迁移|重构)/,
  /(?:验证|测试|校验|确认一下|跑通|编译|上机)/,
  /(?:传给|传进|传到|接入|接到|接上|连到|接入|传递|转发)/,
  /\b(?:check|read|open|inspect|look at|search|grep)\b/i,
  /\b(?:edit|write|create|add|remove|delete|rewrite|patch|update)\b/i,
  /\b(?:run|execute|install|deploy|build|start|restart|publish)\b/i,
  /\b(?:fix|implement|refactor|migrate|verify|test)\b/i,
];

/** 尾部形态加权。冒号不足以独立触发，见文件头第 3 条。 */
const COLON_TAIL = /[:：]\s*$/;
const ELLIPSIS_TAIL = /(?:\.{3,}|…)\s*$/;

/**
 * 整条回复只有一个续跑词。
 *
 * 实测（pi 会话 01a18ce2，provider=trae）：用户发「继续」，模型原样回了 "\n继续"
 * 就 stop，零工具调用 —— 用户看到的就是「说继续就不动了」。
 * 这不是「太短所以不判」：它没有给出任何结论，是没作答。
 */
const BARE_CONTINUE = /^(?:继续|继续吧|接着|接着来|往下|go on|continue|keep going|proceed)[\s。.!！?？]*$/i;

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
 *          | 'standing-rule' | 'already-done' | 'no-future-cue' | 'weak-only',
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

  // 整条回复只是一个「继续」之类的续跑词（实测：trae 回了 "\n继续" 就 stop，零工具调用）。
  // 这不是「太短所以不判」—— 它不是结论，是没作答。too-short 会把它放过去。
  if (BARE_CONTINUE.test(text)) {
    return { stall: true, verdict: 'bare-continue', score: 0, signals: ['bare-continue'], prompt: BARE_REPLY_PROMPT };
  }

  if (weightedLength(text) < MIN_WEIGHTED_CHARS) return { ...empty, verdict: 'too-short' };

  const tail = tailOf(text);
  const trimmedRaw = raw.trim();

  // ── 否决 ①：以问句收尾 ────────────────────────────────────────────────────
  // 模型在提问时同样会「不调工具就停」，那是在等用户，不是漏执行。
  if (/[?？]\s*$/.test(trimmedRaw)) return { ...empty, verdict: 'question' };

  // ── 否决 ②：把决定权交回用户 ─────────────────────────────────────────────
  if (anyMatch(REQUEST_PATTERNS, tail)) return { ...empty, verdict: 'asked-user' };

  // ── 否决 ③：确认/复述长期规则约定（「以后遇到…我会先…」）────────────────
  if (anyMatch(STANDING_RULE_PATTERNS, tail)) return { ...empty, verdict: 'standing-rule' };

  const hasStrongFuture = anyMatch(FUTURE_STRONG, tail);
  const hasWeakFuture = anyMatch(FUTURE_WEAK, tail);
  const hasPendingWork = anyMatch(PENDING_WORK, tail);

  // ── 否决 ④：明确宣告完成且没有未来时/待办时 ─────────────────────────────
  if (!hasStrongFuture && !hasWeakFuture && !hasPendingWork && anyMatch(DONE_PATTERNS, tail)) {
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
  const hasVerb = anyMatch(ACTION_VERB, tail);
  if (hasVerb) {
    score += 1;
    signals.push('action-verb');
  }
  const hasColon = COLON_TAIL.test(trimmedRaw);
  if (hasColon) {
    score += 1.5;
    signals.push('colon-tail');
  }
  if (ELLIPSIS_TAIL.test(trimmedRaw)) {
    score += 0.5;
    signals.push('ellipsis-tail');
  }
  if (hasPendingWork) {
    score += 3;
    signals.push('pending-work');
  }

  // 末行非列表项以「动作动词 + 冒号」收尾（例如「……整份重写干净：」）：
  // 即使省略了显式「我先/接下来」代词，也是典型的即将发起工具调用。
  //
  // 动词必须落在冒号前的**最后一个分句**里。只看「整行有没有动词」会把
  // 「已定位问题并修好，根因有三层：」这类说明性收尾也算进来 —— 它的动词
  // 在句中描述已完成的事，冒号引出的是名词性解释，不是待办。按设计原则第 1
  // 条，宁可漏掉一次续跑，也不能把一条说明性收尾当成漏执行。
  const lastLine = trimmedRaw.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  const tailClause = lastLine.replace(/[:：]\s*$/, '').split(/[，,。；;！!？?]/).pop() ?? '';
  const isActionColon = hasColon && hasVerb && anyMatch(ACTION_VERB, tailClause)
    && !/^[-*•\d|]/.test(lastLine) && lastLine.length <= 160;
  if (!hasStrongFuture && !hasWeakFuture && isActionColon) {
    score += 1;
    signals.push('action-colon');
  }

  if (!hasStrongFuture && !hasWeakFuture && !isActionColon && !hasPendingWork) {
    return { stall: false, verdict: 'no-future-cue', score, signals, prompt: null };
  }

  const threshold = hasStrongFuture || isActionColon || hasPendingWork ? THRESHOLD_STRONG : THRESHOLD_WEAK_ONLY;
  if (score < threshold) {
    return { stall: false, verdict: 'weak-only', score, signals, prompt: null };
  }

  return { stall: true, verdict: 'stall', score, signals, prompt: CONTINUE_PROMPT };
}

/**
 * 布尔判定便捷封装（供只需 boolean 的调用方使用）。
 *
 * @param {string} rawText
 * @param {{ toolCallCount?: number }} [options]
 * @returns {boolean}
 */
export function looksLikeAbandonedStep(rawText, options = {}) {
  return detectStall(rawText, options).stall;
}

/**
 * 回灌给模型的续跑提示。
 *
 * 刻意不命令「继续」，而是给出三个出口：执行 / 说明为何不需要执行 / 提出具体问题。
 * 只写「继续」会让模型重复一遍刚才那段计划。
 */
export const CONTINUE_PROMPT = [
  '你上一条回复宣布了下一步操作（例如「我先…」「接下来…」「Let me…」），但没有调用任何工具就结束了这一轮。',
  '请直接执行这个操作：下一条消息要包含实际的工具调用，而不是又一段计划描述。',
  '如果它其实已经完成，或不需要执行，用一句话说明结论即可，不要重述计划。',
  '如果需要用户先决定，提出一个具体的问题，不要继续描述待办。',
].join('\n');

/**
 * 空回合的续跑提示：模型只留下思考过程（thinking），既没有正文也没有工具调用。
 *
 * 实测故障模式（2026-10-30，pi 会话 01a1880e，provider=workbuddy / hy4-preview）：
 * usage 显示 output 有 286 / 667 个 token、reasoning 145 / 457，耗时 7.6s、15.5s
 * （不是超时被切），但 content 里只有 thinking 块，正文为空。用户看到的就是
 * 「思考着，突然不工作了」。
 *
 * 与 CONTINUE_PROMPT 的区别：那一条假定还有可见文本可以判断意图；这里什么都
 * 没有，所以不能说「执行你宣布的操作」—— 只能要求它把结论说出来。
 */
export const EMPTY_TURN_PROMPT = [
  '你上一条回复只留下了思考过程，没有给出任何可见内容，也没有调用任何工具。',
  '请把你的结论直接说出来：已经做了什么、接下来要做什么，或者一句话说明这一轮的结果。',
  '不要重复思考过程，也不要只描述计划而不动手。',
].join('\n');

/**
 * 整条回复只有「继续」这类续跑词时的提示。
 *
 * 与 CONTINUE_PROMPT 的区别：那一条假设模型宣布了某个具体动作，可以直接执行；
 * 这里连动作都没说，只能要求它把下一步真正做出来，或者说明已经结束。
 */
export const BARE_REPLY_PROMPT = [
  '你上一条回复只有「继续」这类词，没有实际内容，也没有调用任何工具。',
  '请直接执行你计划中的下一步；如果这一轮其实已经结束，用一句话说明结论，不要只回一个「继续」。',
].join('\n');

export default detectStall;
