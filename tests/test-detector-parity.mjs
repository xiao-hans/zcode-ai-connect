#!/usr/bin/env node
/**
 * JS ↔ Python 检测器一致性测试。
 *
 * 判定逻辑现在有两份实现：`shared/stall-detector.mjs`（ZCode / pi / dsh）与
 * `shared/stall_detector.py`（hermes）。两份实现漂移是这套功能最隐蔽的失效方式 ——
 * 症状是「在 ZCode 里会续跑的话，在 hermes 里不续跑」，而没有任何报错。
 *
 * 所以这里把同一批文本喂给两边，逐字段比对 verdict / score / signals / stall。
 * 任何一边改了规则而另一边没跟上，这个测试就会红。
 *
 * Run: node zcode-ai-connect/tests/test-detector-parity.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { detectStall } from '../shared/stall-detector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_DETECTOR = join(HERE, '..', 'shared', 'stall_detector.py');

/** 用例集合：与 test-stall-detector.mjs 同源，另加几条特意为难实现差异的输入。 */
const CASES = [
  // 该续跑
  { text: '我先检查配置，再修改这里：' },
  { text: '接下来我来实现这个 hook，然后跑一遍测试：' },
  { text: '我先把四个包的 plugin.json 都加上 Stop 注册，再统一验证。' },
  { text: 'Let me check the config first, then patch the providers block:' },
  { text: '我先读取 config.yaml 里的 providers 段，再定位重复的那两个键。' },
  { text: 'Now I\'ll patch the file...' },
  // action-colon：省略了「我先/接下来」，靠冒号前的动作动词识别
  { text: '好的，我已经看完了，现在把这份配置整份重写干净：' },
  // 不该续跑
  { text: '需要我先确认一下端口状态吗？' },
  { text: '请确认后我再执行。' },
  { text: '接下来需要你决定用哪个方案，我再动手。' },
  { text: '已完成全部修改，测试通过。' },
  { text: '已定位问题并修好，根因有三层：' },
  // 长期规则/未来条件约定：回答的是「以后怎么做」，不是本回合漏调工具
  { text: '可以，主人。以后遇到这种情况我会先确认再动手执行。' },
  { text: '好的，以后每次你让我改配置，我都会先备份再动手。' },
  { text: '好的。' },
  { text: '下面这段代码是完整实现：\n\n```js\nconst a = 1;\n```\n' },
  { text: '总结：三个改动都已完成，没有其他需要改动的地方。' },
  { text: 'The config looks fine. Let me know if you want me to change the timeout.' },
  { text: '配置形状如下：\n\n```yaml\n# 接下来我来改这里\nproviders: {}\n```\n' },
  // 边界：空 / null / 超长 / 代码块 / 链接 / HTML
  { text: '' },
  { text: null },
  { text: '   \n\n  ' },
  { text: '我先检查配置，再修改这里：', toolCallCount: 2 },
  { text: '我看过 [这个文档](https://example.com/a/b/c) 了，接下来我改代码：' },
  { text: '<b>接下来</b>我来改这里：' },
  { text: '接下来我来改' + '这里，'.repeat(40) + '：' },
  { text: '接下来' + '…' },
  { text: 'First, I will read the file. Then I will patch it.' },
  { text: 'Let me know what you think.' },
  { text: 'All done — nothing more to do here.' },
  { text: '我这就去改。' },
  { text: '我这就去改' + '，'.repeat(30) },
];

/** 找一个可用的 Python：环境变量优先，其次 PATH 里的 python/python3，最后 hermes 自带的。 */
function findPython() {
  const candidates = [
    process.env.STALL_PYTHON,
    'python',
    'python3',
    'C:/Users/HANXIAO/AppData/Local/hermes/tools/python-3.14.9+20261021-win32-x64/python.exe',
  ].filter(Boolean);
  for (const exe of candidates) {
    const probe = spawnSync(exe, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 15000 });
    if (probe.status === 0 && probe.stdout.trim() === '1') return exe;
  }
  return null;
}

function runPython(python, cases) {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dirname(PY_DETECTOR))})
from stall_detector import detect_stall
cases = json.load(sys.stdin)
out = [detect_stall(c.get("text"), c.get("toolCallCount") or 0) for c in cases]
json.dump(out, sys.stdout, ensure_ascii=False)
`;
  const result = spawnSync(python, ['-c', script], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`python failed (status=${result.status}): ${(result.stderr || '').slice(0, 500)}`);
  }
  return JSON.parse(result.stdout);
}

console.log('test-detector-parity');

if (!existsSync(PY_DETECTOR)) {
  console.log(`  FAIL 找不到 Python 版检测器: ${PY_DETECTOR}`);
  process.exit(1);
}

const python = findPython();
if (!python) {
  console.log('  SKIP 没有可用的 Python 解释器（设 STALL_PYTHON 指定）');
  process.exit(0);
}
console.log(`  using ${python}`);

const pyResults = runPython(python, CASES);
assert.equal(pyResults.length, CASES.length, 'python 返回条数与用例数不符');

let passed = 0;
let failed = 0;

CASES.forEach((testCase, index) => {
  const label = `${JSON.stringify(String(testCase.text ?? '').slice(0, 34))}${testCase.toolCallCount ? ` tools=${testCase.toolCallCount}` : ''}`;
  const js = detectStall(testCase.text, { toolCallCount: testCase.toolCallCount ?? 0 });
  const py = pyResults[index];
  try {
    assert.equal(py.verdict, js.verdict, `verdict: py=${py.verdict} js=${js.verdict}`);
    assert.equal(py.stall, js.stall, `stall: py=${py.stall} js=${js.stall}`);
    assert.equal(py.score, js.score, `score: py=${py.score} js=${js.score}`);
    assert.deepEqual(py.signals, js.signals, `signals: py=[${py.signals}] js=[${js.signals}]`);
    assert.equal(py.prompt, js.prompt, 'prompt 文本不一致');
    passed += 1;
    console.log(`  ok   ${label} → ${js.verdict}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}\n       ${error.message.split('\n')[0]}`);
  }
});

// CONTINUE_PROMPT 必须逐字一致：它是回灌给模型的话，两边措辞不同会让行为不可预期。
const pyPrompt = pyResults.find((r) => r.prompt)?.prompt ?? null;
const jsPrompt = detectStall('我先检查配置，再修改这里：').prompt;
try {
  assert.equal(pyPrompt, jsPrompt, 'CONTINUE_PROMPT 文本不一致');
  passed += 1;
  console.log('  ok   CONTINUE_PROMPT 逐字一致');
} catch (error) {
  failed += 1;
  console.log(`  FAIL CONTINUE_PROMPT\n       ${error.message.split('\n')[0]}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
