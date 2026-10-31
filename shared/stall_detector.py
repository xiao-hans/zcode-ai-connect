"""stall_detector —— 「宣布了下一步却没调用工具」的启发式判定（Python 版）。

与 ``shared/stall-detector.mjs`` 逐条对齐，供 hermes 的回合结束闸门使用。
**两份实现必须同步**：改任意一份都要跑 ``node tests/test-detector-parity.mjs``，
它会把同一批用例喂给两边的实现并逐字段比对（verdict / score / signals）。

设计约束与 JS 版一致：

 1. 这是启发式，不是判定器。宁可漏掉一次续跑，也不要打断一条正常收尾的回复。
 2. 否决（veto）规则先于肯定（cue）规则求值。
 3. 冒号只是加权项，不足以独立触发。
 4. 零依赖、纯函数、无 IO —— 会被复制进宿主包，不能 import 本项目其他模块。

与 JS 版的唯一刻意差异：返回值是 dict 而不是对象字面量。
"""

from __future__ import annotations

import re
from typing import Any, Dict

__all__ = ["detect_stall", "CONTINUE_PROMPT", "EMPTY_TURN_PROMPT", "BARE_REPLY_PROMPT"]

# 上限：只看最后两块 + 最多 600 字符。更早的内容是背景，不是收尾意图。
TAIL_BLOCK_COUNT = 2
TAIL_CHAR_LIMIT = 600

# 低于这个（加权）长度的回复不判 —— 「好的。」「Done.」没有可续跑的动作。
# 中日韩文字按 1.6 字计权：同样表达一个完整动作，中文比英文短得多。
MIN_WEIGHTED_CHARS = 14.0

# 请求用户裁决 / 提供输入的措辞。命中即否决。
REQUEST_PATTERNS = [
    # 中文：把决定权交回用户
    r"请你?(?:确认|批准|授权|选择|决定|提供|粘贴|发送|告知|告诉|现在|立刻|马上|配合|扫码|扫|在)",
    r"你(?:可以|需要|来)(?:确认|决定|选择|提供|先)",
    r"需要你(?:确认|决定|操作|提供|回复|选择)",
    r"(?:是否|要不要|需不需要|要不要我|需要我)(?:继续|执行|我|帮|先|再)?",
    r"等你(?:确认|回复|决定|操作|安排)",
    r"告诉我(?:你|是否|要|结果|选择|一声|什么时候)",
    r"(?:说|吱|喊)一声",
    r"你(?:点个?头|说[「“\"']?开[」”\"']?)(?:我就|我立刻|我马上)?",
    r"要我[^。！？\n]{0,24}(?:就|的话|吗)",
    r"扫完(?:不用回复|告诉我|说一声)",
    r"让我知道",
    r"由你(?:决定|来|选|定)",
    r"你(?:先|来)(?:确认|决定|操作|选|说)",
    r"确认后(?:我)?再",
    r"(?:你|您)看(?:看|一下)?(?:是否|要不要|行不行)",
    # English: handing the decision back
    r"\blet me know\b",
    r"\bwould you like\b",
    r"\bdo you want\b",
    r"\bshall i\b",
    r"\bplease (?:confirm|advise|provide|choose)\b",
    r"\byour call\b",
    r"\bwhich (?:one|option|approach) (?:do you|would you)\b",
    r"\bcan you (?:confirm|provide|share|tell)\b",
    r"\bwaiting (?:for|on) your\b",
]

# 确认/复述长期规则或未来条件约定（「以后遇到…我会先…」「可以，主人。以后…」）。
# 这是回答用户的规则设定，不是当前回合宣布下一步动作后漏调工具。
STANDING_RULE_PATTERNS = [
    r"(?:以后|今后|之后|下次|后续|往后|接下来每次|每当|每次)[^。！？\n]{0,40}(?:提到|遇到|收到|让我|你让我|要求|需要|开始|做|时|的时候)[^。！？\n]{0,30}我(?:会|将|都会|先|就)",
    r"^(?:可以|好的?|明白|没问题|收到|记下了|知道了)[，,。！!\s]*(?:主人|小主|老板)?[，,。！!\s]*(?:以后|今后|之后|下次|后续|往后|每当|每次)",
]

# 「已经做完」的收尾。命中且无未来标记时否决。
DONE_PATTERNS = [
    r"(?:已|已经)(?:经)?(?:完成|修好|改好|搞定|处理完|就绪|生效|上线|发布|通过)",
    r"(?:全部|都)(?:完成|通过|搞定|就绪|闭合)",
    r"(?:搞定|收工|完事|可以收尾)(?:了)?[。.!！]?$",
    r"(?:到|就)这里(?:为止|结束)?",
    r"(?:没有|无需)(?:其他|更多|别的)(?:改动|问题|需要)",
    r"\b(?:all )?done\b",
    r"\b(?:finished|completed|ready to go)\b",
    r"\bnothing (?:else|more) (?:to do|needed)\b",
    r"\ball (?:tests? )?pass(?:ed|ing)?\b",
]

# 强未来标记：明确宣布「我即将做」。单独出现即高置信。
FUTURE_STRONG = [
    # 「我先…」「我这就…」是中文里最典型的「宣布即将动手」，不必再跟动词。
    r"我(?:先|这就|马上|立刻|接下来|现在)",
    r"我(?:来|将|会|要|去)(?:先|先来)?",
    # 「我查一下…」「我看一下…」：第一人称 + 具体动作 + 量词，等同于宣布马上动手。
    # 刻意要求量词 —— 单独的「我看」是表态（「我看行」），不是动作，不能算强信号。
    r"我(?:查|看|确认|核对|验证|测试|跑|试|改|写|读|安装|重启|整理|搜索|定位|排查|梳理|对比|修)(?:一下|一遍|下|一把)",
    r"先让我",
    r"让(?:我们|我)先",
    r"(?:接下来|下面|现在)我(?:来|将|会|要)",
    r"开始(?:执行|处理|修改|实现|写|改|跑|检查)",
    r"(?:^|[。！？\n]\s*)(?:开始[。，,\s]*)?先(?:把|将|从|去|给|对|用|跑|看|查|改|写|读|登记|核对|整理|创建|执行|检查)[^。！？\n]{1,60}再",
    r"(?:^|[。！？\n]\s*)现在(?:重新|开始|把|将|先|去|来|给|对|跑|开|改|写|整理|执行|检查)",
    r"\blet me\b",
    r"\bi'?ll\b",
    r"\bi will\b",
    r"\bi'?m going to\b",
    r"\bnow i'?ll\b",
    r"\blet'?s\b",
]

# 弱未来标记：推进语，但单独不足以说明「要动手」—— 也可能是继续讲解。
FUTURE_WEAK = [
    r"接下来",
    r"下一步",
    r"下面(?:我|我们)?",
    r"然后(?:我|我们)?",
    r"首先",
    r"现在(?:我|我们)?",
    r"\bnext,?\b",
]

# 动作动词：把「未来时」落到「要做一件具体的事」上。
ACTION_VERB = [
    r"(?:检查|查看|看看|查一下|读取|打开|搜索|定位|核对|登记|整理)",
    r"(?:修改|改成|改掉|编辑|写入|创建|新建|删除|移除|重写|写进)",
    r"(?:执行|运行|跑一下|跑起|启动|重启|安装|部署|发布|提交|开窗口|重新开)",
    r"(?:修复|实现|添加|增加|补充|更新|替换|迁移|重构)",
    r"(?:验证|测试|校验|确认一下|跑通|编译|上机)",
    r"\b(?:check|read|open|inspect|look at|search|grep)\b",
    r"\b(?:edit|write|create|add|remove|delete|rewrite|patch|update)\b",
    r"\b(?:run|execute|install|deploy|build|start|restart|publish)\b",
    r"\b(?:fix|implement|refactor|migrate|verify|test)\b",
]

# 尾部形态加权。冒号不足以独立触发。
COLON_TAIL = re.compile(r"[:：]\s*\Z")
ELLIPSIS_TAIL = re.compile(r"(?:\.{3,}|…)\s*\Z")

# 整条回复只有一个续跑词。实测（pi 会话 01a18ce2，provider=trae）：用户发「继续」，
# 模型原样回了 "\n继续" 就 stop，零工具调用 —— 用户看到的就是「说继续就不动了」。
# 这不是「太短所以不判」：它没有给出任何结论，是没作答。
BARE_CONTINUE = re.compile(
    r"^(?:继续|继续吧|接着|接着来|往下|go on|continue|keep going|proceed)[\s。.!！?？]*\Z",
    re.IGNORECASE,
)
QUESTION_TAIL = re.compile(r"[?？]\s*\Z")

# action-colon 判定用：末行收尾的冒号、分句切分、列表项前缀。
_COLON_AT_END = re.compile(r"[:：]\s*\Z")
_CLAUSE_SPLIT = re.compile(r"[，,。；;！!？?]")
_LIST_ITEM = re.compile(r"^[-*•\d|]")

# 阈值。只有弱未来标记时必须靠额外信号才能过线。
THRESHOLD_STRONG = 3.0
THRESHOLD_WEAK_ONLY = 4.5

_CJK_CHAR = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

_COMPILED: Dict[str, list] = {}


def _compile(group: str, patterns: list) -> list:
    """每个模式组只编译一次，且大小写不敏感（与 JS 版逐条带 ``i`` 等价）。

    注意：JS 版里只有英文模式带 ``i``，中文模式没有。这里统一用 IGNORECASE
    是安全的 —— 中文模式不含字母，加不加都一样。
    """
    if group not in _COMPILED:
        _COMPILED[group] = [re.compile(p, re.IGNORECASE) for p in patterns]
    return _COMPILED[group]


def _any_match(group: str, text: str) -> bool:
    return any(rx.search(text) for rx in _compile(group, _PATTERN_GROUPS[group]))


_PATTERN_GROUPS = {
    "request": REQUEST_PATTERNS,
    "standing_rule": STANDING_RULE_PATTERNS,
    "done": DONE_PATTERNS,
    "future_strong": FUTURE_STRONG,
    "future_weak": FUTURE_WEAK,
    "action_verb": ACTION_VERB,
}


def _strip_noise(text: str) -> str:
    """去掉代码围栏/行内代码/标签 —— 代码里的冒号和动词不是模型的收尾意图。"""
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"`[^`\n]*`", " ", text)
    text = re.sub(r"</?[a-zA-Z][^>]{0,200}>", " ", text)
    text = re.sub(r"\[[^\]]{0,80}\]\([^)]{0,300}\)", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _tail_of(text: str) -> str:
    """最后两块非空段落，按字符上限截尾。"""
    blocks = [b.strip() for b in re.split(r"\n{2,}", text) if b.strip()]
    if not blocks:
        return ""
    joined = "\n".join(blocks[-TAIL_BLOCK_COUNT:]).strip()
    return joined[-TAIL_CHAR_LIMIT:] if len(joined) > TAIL_CHAR_LIMIT else joined


def _weighted_length(text: str) -> float:
    """中日韩字符按 1.6 计权后的长度，见 MIN_WEIGHTED_CHARS。"""
    return sum(1.6 if _CJK_CHAR.match(ch) else 1.0 for ch in text)


def _result(verdict: str, score: float = 0.0, signals=None, stall: bool = False) -> Dict[str, Any]:
    return {
        "stall": stall,
        "verdict": verdict,
        "score": score,
        "signals": list(signals or []),
        "prompt": CONTINUE_PROMPT if stall else None,
    }


def detect_stall(raw_text: Any, tool_call_count: int = 0) -> Dict[str, Any]:
    """判定一条 assistant 收尾文本是否「宣布了下一步却没动手」。

    ``tool_call_count > 0`` 一律不判 —— 已经有工具调用的轮次不存在「只说不做」。
    """
    if tool_call_count > 0:
        return _result("had-tools")

    raw = "" if raw_text is None else str(raw_text).strip()
    if raw == "":
        return _result("empty")

    text = _strip_noise(raw)

    # 整条回复只是一个「继续」之类的续跑词：它是没作答，不是「太短所以不判」。
    if BARE_CONTINUE.match(text):
        return {
            "stall": True,
            "verdict": "bare-continue",
            "score": 0.0,
            "signals": ["bare-continue"],
            "prompt": BARE_REPLY_PROMPT,
        }

    if _weighted_length(text) < MIN_WEIGHTED_CHARS:
        return _result("too-short")

    tail = _tail_of(text)

    # ── 否决 ①：以问句收尾 ────────────────────────────────────────────────
    if QUESTION_TAIL.search(raw):
        return _result("question")

    # ── 否决 ②：把决定权交回用户 ──────────────────────────────────────────
    if _any_match("request", tail):
        return _result("asked-user")

    # ── 否决 ③：确认/复述长期规则约定（「以后遇到…我会先…」）──────────────
    if _any_match("standing_rule", tail):
        return _result("standing-rule")

    has_strong = _any_match("future_strong", tail)
    has_weak = _any_match("future_weak", tail)

    # ── 否决 ④：明确宣告完成且没有未来时 ──────────────────────────────────
    if not has_strong and not has_weak and _any_match("done", tail):
        return _result("already-done")

    # ── 打分 ──────────────────────────────────────────────────────────────
    score = 0.0
    signals = []

    if has_strong:
        score += 2.0
        signals.append("future-strong")
    if has_weak:
        score += 1.5
        signals.append("future-weak")
    has_verb = _any_match("action_verb", tail)
    if has_verb:
        score += 1.0
        signals.append("action-verb")
    has_colon = bool(COLON_TAIL.search(raw))
    if has_colon:
        score += 1.5
        signals.append("colon-tail")
    if ELLIPSIS_TAIL.search(raw):
        score += 0.5
        signals.append("ellipsis-tail")

    # 末行非列表项以「动作动词 + 冒号」收尾（例如「……整份重写干净：」）：
    # 即使省略了显式「我先/接下来」代词，也是典型的即将发起工具调用。
    #
    # 动词必须落在冒号前的**最后一个分句**里，否则「已定位问题并修好，根因有
    # 三层：」这类说明性收尾会被误判 —— 它的动词讲的是已完成的事，冒号引出的
    # 是名词性解释。宁可漏掉一次续跑，也不要把说明性收尾当成漏执行。
    lines = [line.strip() for line in raw.split("\n") if line.strip()]
    last_line = lines[-1] if lines else ""
    tail_clause = _CLAUSE_SPLIT.split(_COLON_AT_END.sub("", last_line))[-1] if last_line else ""
    is_action_colon = (
        has_colon
        and has_verb
        and _any_match("action_verb", tail_clause)
        and not _LIST_ITEM.match(last_line)
        and len(last_line) <= 160
    )
    if not has_strong and not has_weak and is_action_colon:
        score += 1.0
        signals.append("action-colon")

    if not has_strong and not has_weak and not is_action_colon:
        return _result("no-future-cue", score, signals)

    threshold = THRESHOLD_STRONG if (has_strong or is_action_colon) else THRESHOLD_WEAK_ONLY
    if score < threshold:
        return _result("weak-only", score, signals)

    return _result("stall", score, signals, stall=True)


# 回灌给模型的续跑提示。
#
# 刻意不命令「继续」，而是给出三个出口：执行 / 说明为何不需要执行 / 提出具体问题。
# 只写「继续」会让模型重复一遍刚才那段计划。
CONTINUE_PROMPT = "\n".join([
    "你上一条回复宣布了下一步操作（例如「我先…」「接下来…」「Let me…」），但没有调用任何工具就结束了这一轮。",
    "请直接执行这个操作。",
    "如果它其实已经完成，或不需要执行，用一句话说明结论即可，不要重述计划。",
    "如果需要用户先决定，提出一个具体的问题，不要继续描述待办。",
])

# 空回合的续跑提示：模型只留下思考过程（thinking），既没有正文也没有工具调用。
#
# 实测故障模式（2026-10-30，pi 会话 01a1880e，provider=workbuddy / hy4-preview）：
# usage 显示 output 有 286 / 667 个 token、reasoning 145 / 457，耗时 7.6s、15.5s
# （不是超时被切），但 content 里只有 thinking 块，正文为空。用户看到的就是
# 「思考着，突然不工作了」。
#
# 与 CONTINUE_PROMPT 的区别：那一条假定还有可见文本可以判断意图；这里什么都
# 没有，所以不能说「执行你宣布的操作」—— 只能要求它把结论说出来。
EMPTY_TURN_PROMPT = "\n".join([
    "你上一条回复只留下了思考过程，没有给出任何可见内容，也没有调用任何工具。",
    "请把你的结论直接说出来：已经做了什么、接下来要做什么，或者一句话说明这一轮的结果。",
    "不要重复思考过程，也不要只描述计划而不动手。",
])

# 整条回复只有「继续」这类续跑词时的提示。与 CONTINUE_PROMPT 的区别：那一条假设
# 模型宣布了某个具体动作可以直接执行；这里连动作都没说，只能要求它真的做出来。
BARE_REPLY_PROMPT = "\n".join([
    "你上一条回复只有「继续」这类词，没有实际内容，也没有调用任何工具。",
    "请直接执行你计划中的下一步；如果这一轮其实已经结束，用一句话说明结论，不要只回一个「继续」。",
])
