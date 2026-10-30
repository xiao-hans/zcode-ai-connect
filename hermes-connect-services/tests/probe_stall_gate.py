"""给 tests/test-stall-gate.mjs 调用的探针：在宿主进程里跑真实闸门链。

输出 JSON 行，一行一个用例，便于 Node 侧断言。找不到 hermes 时由调用方 SKIP，
这里不做探测。
"""
import json
import sys

agent_root = sys.argv[1]
sys.path.insert(0, agent_root)

from agent.turn_stop_gates import _ZC_STALL_MAX_NUDGES, apply_stop_gates  # noqa: E402


class FakeAgent:
    def __init__(self):
        self._session_messages = []
        self._turn_file_mutation_paths = set()
        self.platform = "cli"
        self.session_id = "stall-gate-test"
        self.model = "test/model"

    def _interim_content_was_streamed(self, text):
        return True

    def _emit_interim_assistant_message(self, msg):
        pass

    def _flush_messages_to_session_db(self, messages, history):
        pass

    def _emit_diagnostic_status(self, text):
        pass


def run(text, tools=0):
    agent = FakeAgent()
    messages = [{"role": "user", "content": "帮我看看那个配置文件"}]
    for i in range(tools):
        messages.append({
            "role": "assistant", "content": "",
            "tool_calls": [{"id": f"c{i}", "type": "function",
                            "function": {"name": "read_file", "arguments": "{}"}}],
        })
        messages.append({"role": "tool", "content": "ok", "tool_call_id": f"c{i}"})
    verdict = apply_stop_gates(
        agent, {"role": "assistant", "content": text},
        final_response=text, messages=messages, conversation_history=[],
        pending_verification_response=None, pending_verification_response_previewed=False,
    )
    return {
        "continue_turn": bool(verdict.continue_turn),
        "nudge_role": messages[-1].get("role") if isinstance(messages[-1], dict) else None,
        "nudge": messages[-1].get("content") if verdict.continue_turn else None,
        "fallback": verdict.pending_verification_response,
    }


CASES = [
    {"name": "announce+colon", "text": "我先检查配置，再修改这里：", "tools": 0, "expect": True},
    {"name": "done", "text": "已完成全部修改，测试通过。", "tools": 0, "expect": False},
    {"name": "question", "text": "需要我先确认一下端口状态吗？", "tools": 0, "expect": False},
    {"name": "handed-back", "text": "接下来需要你决定用哪个方案，我再动手。", "tools": 0, "expect": False},
    {"name": "had-tools", "text": "我先检查配置，再修改这里：", "tools": 2, "expect": False},
    {"name": "english", "text": "Let me check the config first, then patch the providers block:", "tools": 0, "expect": True},
]

print(json.dumps({"max_nudges": _ZC_STALL_MAX_NUDGES}))
for case in CASES:
    result = run(case["text"], case["tools"])
    result["name"] = case["name"]
    result["expect"] = case["expect"]
    print(json.dumps(result, ensure_ascii=False))


def budget_probe():
    """同一 agent 连跑多次收尾闸：预算应按轮计（2 次），新用户消息后重置。

    闸门注入的提示带 flag=True，_zc_stall_guard_turn_key 会跳过它，
    所以同一轮里续跑不会把自己当成新回合 —— 这里正是验证这一点。
    """
    agent = FakeAgent()
    messages = [{"role": "user", "content": "开始"}]

    def fire(text):
        verdict = apply_stop_gates(
            agent, {"role": "assistant", "content": text},
            final_response=text, messages=messages, conversation_history=[],
            pending_verification_response=None, pending_verification_response_previewed=False,
        )
        return bool(verdict.continue_turn)

    same_turn = [
        fire("我先检查配置，再修改这里："),
        fire("好的，我先看一下日志再定位："),
        fire("接下来我要把配置改掉："),
    ]
    messages.append({"role": "user", "content": "换个问题"})
    after_new_turn = fire("好的，我先看一下日志再定位：")
    return {"name": "per-turn-budget", "same_turn": same_turn, "after_new_user": after_new_turn}


print(json.dumps(budget_probe(), ensure_ascii=False))
