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
import { detectStall, CONTINUE_PROMPT } from '../shared/stall-detector.mjs';

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
