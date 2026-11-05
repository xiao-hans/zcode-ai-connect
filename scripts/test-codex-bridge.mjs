#!/usr/bin/env node
// 桥协议验证:1) 纯文本流式回合 2) 强制工具调用回合。只打印事件摘要。
const BASE = 'http://127.0.0.1:39268';

async function run(label, body) {
  const r = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) { console.log(`${label}: HTTP ${r.status} ${await r.text().then(t => t.slice(0, 200))}`); return; }
  const events = [];
  let text = '', toolCalls = [];
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const evLine = frame.split('\n').find(l => l.startsWith('event:'));
      const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
      if (!evLine || !dataLine) continue;
      const ev = evLine.slice(6).trim();
      let d = {}; try { d = JSON.parse(dataLine.slice(5)); } catch {}
      events.push(ev);
      if (ev === 'response.output_text.delta') text += d.delta;
      if (ev === 'response.output_item.done' && d.item?.type === 'function_call') {
        toolCalls.push(`${d.item.name}(${(d.item.arguments ?? '').slice(0, 80)})`);
      }
      if (ev === 'response.completed') {
        console.log(`${label}: completed usage=${JSON.stringify(d.response?.usage)} output_items=${d.response?.output?.length}`);
      }
      if (ev === 'response.failed') console.log(`${label}: FAILED ${JSON.stringify(d.response?.error).slice(0, 200)}`);
      if (ev === 'response.incomplete') console.log(`${label}: INCOMPLETE(max_output_tokens)`);
    }
  }
  const seq = [...new Set(events)].join(' > ');
  console.log(`${label}: events=${seq}`);
  if (text) console.log(`${label}: text="${text.slice(0, 100)}"`);
  if (toolCalls.length) console.log(`${label}: tool_calls=${toolCalls.join(' | ')}`);
}

await run('wb 纯文本', {
  model: 'wb/glm-5.3',
  instructions: 'You are a test harness. Reply tersely.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: bridge-ok' }] }],
  stream: true,
});

await run('wb 工具调用', {
  model: 'wb/glm-5.3',
  instructions: 'You are a test harness. Use the provided tool when asked.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use the echo tool to echo the string ping.' }] }],
  tools: [{ type: 'function', name: 'echo', description: 'Echo back the given string', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
  tool_choice: 'auto',
  stream: true,
});

await run('qw 纯文本', {
  model: 'qw/qwen3.8-max-preview',
  input: 'Reply with exactly: bridge-ok',
  stream: true,
});
