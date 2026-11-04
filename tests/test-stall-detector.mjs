#!/usr/bin/env node
/**
 * stall-detector 的回归用例。
 *
 * 这组用例的作用不是「证明它能识别 stall」，而是**钉住误判**：每一条 false
 * 用例都对应一种真实会出现的正常收尾，break 掉它们意味着用户会被莫名其妙地
 * 追着再跑一轮。
 *
 * Run: node zcode-ai-connect/tests/test-stall-detector.mjs
 */
import assert from 'node:assert/strict';
import { detectStall, CONTINUE_PROMPT, BARE_REPLY_PROMPT } from '../shared/stall-detector.mjs';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`);
  }
}

const stalls = (text) => {
  const r = detectStall(text);
  assert.equal(r.stall, true, `expected stall, got verdict=${r.verdict} score=${r.score} signals=[${r.signals}]`);
  assert.equal(r.prompt, CONTINUE_PROMPT);
};

const quiet = (text, why) => {
  const r = detectStall(text);
  assert.equal(r.stall, false, `expected no stall, got score=${r.score} signals=[${r.signals}] (${why})`);
  assert.equal(r.prompt, null);
};

console.log('test-stall-detector');

check('鸿蒙 target 待办与安装测试待办（真实停顿）', () => {
  stalls('build-profile 只注册了 `entry` 模块；测试走它的 `ohosTest` target（之前的 `entry_test` 参数名不对，这就是 Script Error 的原因）：');
  stalls('测试 HAP 构建成功。安装测试 HAP 并跑全量套件');
});
check('鸿蒙测试说明、已完成与用户操作不误续', () => {
  quiet('测试走 ohosTest target 已通过。', '已完成');
  quiet('请你安装测试 HAP 并跑全量套件。', '用户操作');
  quiet('安装测试 HAP 并跑全量套件已完成。', '已完成');
});

// ── 该续跑的 ────────────────────────────────────────────────────────────────
check('宣布动作 + 冒号收尾（Cursor 方案里的原例）', () => {
  stalls('我先检查配置，再修改这里：');
});

check('接下来我来…然后跑测试', () => {
  stalls('接下来我来实现这个 hook，然后跑一遍测试：');
});

check('编号待办列表前宣布', () => {
  stalls('我先把四个包的 plugin.json 都加上 Stop 注册，再统一验证。');
});

check('英文 Let me', () => {
  stalls('Let me check the config first, then patch the providers block:');
});

// 待办陈述（2026-11-01，dengying 会话 45cdd3d3，trae/deepseek-v4.1-flash）：
// 模型干完半截活后以「…需要修。」收尾 —— 没有任何时间性未来措辞，
// 旧信号集全部漏过（verdict no-future-cue）。
check('待办陈述:需要修（真实事故回放）', () => {
  stalls('diff 显示 doubanRanking 被插到了 doubanAnime 的 KDoc 和函数之间，结果原 KDoc 变成了 doubanRanking 的文档，doubanAnime 反而没有文档了。需要修。');
});

check('待办陈述:还没验证', () => {
  stalls('主流程改完了，边界情况还没验证。');
});

// 描述条件不算待办：「需要修改才能生效」的尾部是「生效」，是在陈述条件
check('描述性「需要修改才能生效」（不该续跑）', () => {
  quiet('这个配置需要修改才能生效。', '尾部是条件描述，不是待办');
});

// 真实事故回放（pi 会话 01a18ce2，provider=trae）：用户发「继续」，模型原样回
// "\n继续" 就 stop，零工具调用。全文只有 2 个字，会被 too-short 放过去。
check('整条回复只有「继续」', () => {
  for (const text of ['继续', '\n继续', '继续吧', 'continue']) {
    const r = detectStall(text);
    assert.equal(r.stall, true, `expected stall for ${JSON.stringify(text)}, got verdict=${r.verdict}`);
    assert.equal(r.verdict, 'bare-continue');
    assert.equal(r.prompt, BARE_REPLY_PROMPT);
  }
});

check('我先…（无冒号，靠强未来 + 动词过线）', () => {
  stalls('我先读取 config.yaml 里的 providers 段，再定位重复的那两个键。');
});

// 真实事故回放：宣布「我查一下…」后以冒号收尾，却没调工具。
// 冒号 +1.5、动作动词 +1、「我查一下」强未来 +2 = 4.5，过强信号线。
check('「我查一下…」+ 冒号（真实事故回放）', () => {
  const r = detectStall('先别急着让你找——我查一下插件源码和官方文档，确认配对码到底由谁生成：');
  assert.equal(r.stall, true, `expected stall, got verdict=${r.verdict} score=${r.score}`);
  assert.equal(r.score, 4.5, `score=${r.score}`);
  assert.deepEqual(r.signals, ['future-strong', 'action-verb', 'colon-tail']);
  assert.equal(r.prompt, CONTINUE_PROMPT);
});

// ── 不许续跑的 ──────────────────────────────────────────────────────────────
check('提问结尾', () => {
  quiet('需要我先确认一下端口状态吗？', 'question');
});

check('请求用户决定', () => {
  quiet('请确认后我再执行。', 'asked-user');
});

check('交回选择权', () => {
  quiet('接下来需要你决定用哪个方案，我再动手。', 'asked-user');
});

check('条件授权与等待放行（2026-11-04 真实事故回放）', () => {
  // 原事故长句：包含「推荐先跑」「改」「实测」及「等你一句话我来改」
  quiet(
    '**等拍板的两件事**（不影响今晚 17:45 五步轮，链路正常待命）：\\n' +
    '1. **Hermes cron 5 个任务全挂 400**：上游把 gpt-6-luna 从 chat completions 通道下了。修法二选一：改 cron 模型或切 responses 通道 provider。**推荐先跑 `hermes chat -q PONG` 实测哪个模型可用再改**，等你一句话我来改。\\n' +
    '2. 4 个未推送提交 + MR !6 评审、APK 重建——你自己的节奏，我不催。',
    'asked-user',
  );
  // 短句变体
  quiet('推荐先跑 hermes chat -q PONG 实测哪个模型可用再改，等你一句话我来改。', 'asked-user');
  quiet('推荐先跑实测，等你一句话我来改。', 'asked-user');
  quiet('方案 A 还是 B 由你决定，等你发话我就动手。', 'asked-user');
  quiet('只要你一句话我就改。', 'asked-user');
  quiet('先备份当前的配置文件，等你拍板我再改。', 'asked-user');
  quiet('先备份当前的配置文件，等你点头我再改。', 'asked-user');
});

check('已完成宣告', () => {
  quiet('已完成全部修改，测试通过。', 'already-done');
});

// 「可以，主人。以后…」是在复述一条长期规则，不是本轮宣布了动作却漏调工具。
check('复述长期规则约定（standing-rule）', () => {
  const r = detectStall('可以，主人。以后遇到这类问题我会先检查插件源码再动手。');
  assert.equal(r.stall, false, `expected no stall, got score=${r.score}`);
  assert.equal(r.verdict, 'standing-rule');
});

// 「我 + 动词」必须带量词才算强未来：「我看」是表态，不是要动手。
check('表态不算宣布动作', () => {
  quiet('我看这个方案可以，就按它来。', 'no future cue');
});

check('纯说明性冒号收尾（无未来时）', () => {
  quiet('已定位问题并修好，根因有三层：', 'no future cue');
});

check('过短', () => {
  quiet('好的。', 'too-short');
});

check('代码块被剥离后只剩弱信号', () => {
  quiet('下面这段代码是完整实现：\n\n```js\nconst a = 1;\n```\n', 'weak-only');
});

check('总结性收尾带冒号', () => {
  quiet('总结：三个改动都已完成，没有其他需要改动的地方。', 'already-done');
});

check('英文 let me know 交回决定权', () => {
  quiet('The config looks fine. Let me know if you want me to change the timeout.', 'asked-user');
});

// ── 参数与边界 ──────────────────────────────────────────────────────────────
check('toolCallCount > 0 一律不判', () => {
  const r = detectStall('我先检查配置，再修改这里：', { toolCallCount: 2 });
  assert.equal(r.stall, false);
  assert.equal(r.verdict, 'had-tools');
});

check('空输入', () => {
  assert.equal(detectStall('').verdict, 'empty');
  assert.equal(detectStall(null).verdict, 'empty');
  assert.equal(detectStall(undefined).verdict, 'empty');
});

check('代码块里的动词不算信号', () => {
  // 尾部是普通说明，代码块里的「接下来」「我来」不该被看到。
  quiet('配置形状如下：\n\n```yaml\n# 接下来我来改这里\nproviders: {}\n```\n', 'code noise stripped');
});

check('判定结果自洽：stall 时必有 prompt 与 score ≥ 阈值', () => {
  const r = detectStall('我先检查配置，再修改这里：');
  assert.ok(r.score >= 3, `score=${r.score}`);
  assert.ok(r.signals.includes('future-strong'));
  assert.ok(r.signals.includes('colon-tail'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
