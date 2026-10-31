#!/usr/bin/env node
// 临时验证脚本:用 endpoint.json 的 token 对四个端点各发一次最小 chat 请求。
// 只打印每端点一行结果,不输出原始响应体。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CASES = [
  { name: 'qwenwork', model: 'qwen3.8-max-preview' },
  { name: 'qoder', model: 'glm-5.3' },
  { name: 'workbuddy', model: 'glm-5.3' },
  { name: 'trae', model: 'glm-5.3' },
];

const only = process.argv[2] ? process.argv[2].split(',') : null;

for (const c of CASES) {
  if (only && !only.includes(c.name)) continue;
  const epFile = path.join(os.homedir(), `.zcode-${c.name}-connect`, 'endpoint.json');
  let ep;
  try { ep = JSON.parse(fs.readFileSync(epFile, 'utf8')); }
  catch { console.log(`${c.name}: no endpoint.json`); continue; }
  try {
    const h = await fetch(`http://127.0.0.1:${ep.port}/healthz`, { signal: AbortSignal.timeout(3000) });
    const hh = h.ok ? 'up' : `HTTP ${h.status}`;
    const r = await fetch(`http://127.0.0.1:${ep.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
      body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'Reply with exactly: ok' }], stream: true }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await r.text();
    const chunks = text.split('\n').filter(l => l.startsWith('data: {'));
    let content = '', finish = '?';
    for (const line of chunks) {
      try {
        const d = JSON.parse(line.slice(6));
        const t = d.choices?.[0]?.delta?.content;
        if (t) content += t;
        if (d.choices?.[0]?.finish_reason) finish = d.choices[0].finish_reason;
      } catch {}
    }
    const extra = r.ok ? '' : text.slice(0, 200);
    console.log(`${c.name}: health=${hh} chat=HTTP ${r.status} finish=${finish} content="${content.slice(0, 60)}" ${extra}`);
  } catch (e) {
    console.log(`${c.name}: health probe failed — ${e.cause?.code ?? e.message}`);
  }
}
