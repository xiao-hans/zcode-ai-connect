import test from 'node:test';
import assert from 'node:assert/strict';

// 从测试用例直接读取和测试 recoverTextToolCalls 的逻辑行为
// 通过构造微型 server 或提取函数验证

import fs from 'node:fs';

const bridgeCode = fs.readFileSync(new URL('../scripts/codex-responses-bridge.mjs', import.meta.url), 'utf8');

// 提取 recoverTextToolCalls 函数源码并 eval / new Function 运行单测
const fnMatch = bridgeCode.match(/function recoverTextToolCalls[\s\S]*?\n\}/);
if (!fnMatch) {
  throw new Error('recoverTextToolCalls not found in bridge code');
}

const canonicalMatch = bridgeCode.match(/function canonicalToolName[\s\S]*?\n\}/);
if (!canonicalMatch) {
  throw new Error('canonicalToolName not found in bridge code');
}

const fnCode = `${canonicalMatch[0]}\n${fnMatch[0]}\nreturn recoverTextToolCalls;`;
const recoverTextToolCalls = new Function(fnCode)();

const declared = new Set(['bash', 'edit', 'read_file', 'write_file']);

test('Qwen JSON <tool_call> recovery', () => {
  const text = 'Let me run the command:\n<tool_call>{"name": "bash", "arguments": {"command": "ninja --version"}}</tool_call>';
  const res = recoverTextToolCalls(text, declared);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'bash');
  assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), { command: 'ninja --version' });
  assert.equal(res.cleanText.trim(), 'Let me run the command:');
});

test('Qwen XML <function=name><parameter> recovery', () => {
  const text = 'Checking file:\n<function=read_file><parameter=file_path string="true">src/main.cpp</parameter></function>';
  const res = recoverTextToolCalls(text, declared);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'read_file');
  assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), { file_path: 'src/main.cpp' });
  assert.equal(res.cleanText.trim(), 'Checking file:');
});

test('Qwen dangling tags cleanup without crash', () => {
  const text = 'Build failed.\n</parameter>\n</function>\n';
  const res = recoverTextToolCalls(text, declared);
  assert.equal(res.toolCalls.length, 0);
  assert.equal(res.cleanText.trim(), 'Build failed.');
});

test('GLM newline JSON format recovery', () => {
  const text = 'Executing GLM tool:\n<tool_call>bash\n{"command": "git status"}</tool_call>';
  const res = recoverTextToolCalls(text, declared);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'bash');
  assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), { command: 'git status' });
  assert.equal(res.cleanText.trim(), 'Executing GLM tool:');
});

test('GLM xml arg format recovery', () => {
  const text = 'Updating config:\n<tool_call>edit\n<file_path>config.json</file_path><old_string>foo</old_string><new_string>bar</new_string></tool_call>';
  const res = recoverTextToolCalls(text, declared);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'edit');
  assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), { file_path: 'config.json', old_string: 'foo', new_string: 'bar' });
  assert.equal(res.cleanText.trim(), 'Updating config:');
});

test('Generic <function_call> recovery', () => {
  const text = '<function_call>{"name": "bash", "arguments": {"command": "ls"}}</function_call>';
  const res = recoverTextToolCalls(text, declared);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'bash');
  assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), { command: 'ls' });
  assert.equal(res.cleanText.trim(), '');
});

test('Generic <tool_calls> array recovery', () => {
  const text = '<tool_calls>[{"name": "bash", "arguments": {"command": "pwd"}}, {"name": "read_file", "arguments": {"file_path": "a.txt"}}]</tool_calls>';
  const res = recoverTextToolCalls(text, declared);
  assert.equal(res.toolCalls.length, 2);
  assert.equal(res.toolCalls[0].name, 'bash');
  assert.equal(res.toolCalls[1].name, 'read_file');
  assert.equal(res.cleanText.trim(), '');
});

test('Undeclared tool should not be recovered as valid tool call', () => {
  const text = '<tool_call>{"name": "unknown_tool", "arguments": {}}</tool_call>';
  const res = recoverTextToolCalls(text, declared);
  assert.equal(res.toolCalls.length, 0);
  assert.ok(res.cleanText.includes('unknown_tool'));
});
