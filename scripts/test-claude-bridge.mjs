#!/usr/bin/env node
// Claude Code(Anthropic Messages)协议冒烟:纯文本、工具调用、多轮 tool_result、count_tokens。
const BASE = 'http://127.0.0.1:39268';

async function run(label, body, expectStop) {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) { console.log(`${label}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
  const events = [];
  const blocks = [];
  let stop = null;
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const dl = frame.split('\n').find(l => l.startsWith('data:'));
      if (!dl) continue;
      let d; try { d = JSON.parse(dl.slice(5)); } catch { continue; }
      events.push(d.type);
      if (d.type === 'content_block_start') blocks.push({ ...d.content_block, text: '', json: '' });
      if (d.type === 'content_block_delta') {
        const b = blocks[blocks.length - 1];
        if (d.delta.type === 'text_delta') b.text += d.delta.text;
        if (d.delta.type === 'thinking_delta') b.text += d.delta.thinking;
        if (d.delta.type === 'input_json_delta') b.json += d.delta.partial_json;
      }
      if (d.type === 'message_delta') stop = d.delta.stop_reason;
      if (d.type === 'error') console.log(`${label}: ERROR ${JSON.stringify(d.error).slice(0, 200)}`);
    }
  }
  const seq = [...new Set(events)].join(' > ');
  console.log(`${label}: stop=${stop} events=${seq}`);
  for (const b of blocks) {
    if (b.type === 'text') console.log(`${label}: text="${b.text.slice(0, 80)}"`);
    else if (b.type === 'tool_use') console.log(`${label}: tool_use ${b.name}(${(b.json || '{}').slice(0, 80)})`);
    else if (b.type === 'thinking') console.log(`${label}: thinking(${b.text.length} chars)`);
  }
  if (expectStop && stop !== expectStop) console.log(`${label}: ⚠️ stop_reason 期望 ${expectStop}`);
  return blocks;
}

// 1. 纯文本(流式)
await run('wb 纯文本', {
  model: 'wb/glm-5.3',
  max_tokens: 100,
  system: 'You are a test harness. Reply tersely.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: claude-ok' }] }],
  stream: true,
}, 'end_turn');

// 2. 工具调用
const t1 = await run('wb 工具调用', {
  model: 'wb/glm-5.3',
  max_tokens: 300,
  system: 'You are a test harness. Use the provided tool when asked.',
  messages: [{ role: 'user', content: 'Use the echo tool to echo the string ping.' }],
  tools: [{ name: 'echo', description: 'Echo back the given string', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
  stream: true,
}, 'tool_use');

// 3. 多轮:把 tool_result 回灌,期待文本收尾
if (t1) {
  const toolUse = t1.find(b => b.type === 'tool_use');
  if (toolUse) {
    await run('wb 多轮tool_result', {
      model: 'wb/glm-5.3',
      max_tokens: 200,
      messages: [
        { role: 'user', content: 'Use the echo tool to echo the string ping.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: JSON.parse(toolUse.json || '{}') }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'ping' }] },
      ],
      tools: [{ name: 'echo', description: 'Echo back the given string', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
      stream: true,
    }, 'end_turn');
  }
}

// 4. 非流式 + count_tokens
const r2 = await fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'qw/qwen3.8-flash', max_tokens: 50, messages: [{ role: 'user', content: 'Reply with exactly: nostream-ok' }], stream: false }),
  signal: AbortSignal.timeout(120000),
});
if (r2.ok) { const j = await r2.json(); console.log(`qw 非流式: type=${j.type} stop=${j.stop_reason} text="${(j.content ?? []).map(c => c.text ?? '').join('').slice(0, 40)}"`); }
else console.log(`qw 非流式: HTTP ${r2.status}`);
const ct = await fetch(`${BASE}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'wb/glm-5.3', messages: [{ role: 'user', content: 'x'.repeat(400) }] }) });
console.log(`count_tokens: ${JSON.stringify(await ct.json())}`);
