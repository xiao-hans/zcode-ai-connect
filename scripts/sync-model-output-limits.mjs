// 从四个本地端点的 /v1/models 拉取每个模型的真实 max_output_tokens,
// 生成 scripts/model-output-limits.json 供桥按比例夹取输出预算。
// 端点在跑时执行: node scripts/sync-model-output-limits.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = [
  { key: 'wb', tool: 'workbuddy', port: 39271 },
  { key: 'trae', tool: 'trae', port: 39272 },
  { key: 'qoder', tool: 'qoder', port: 39270 },
  { key: 'qw', tool: 'qwenwork', port: 39269 },
];

const limits = {};
const missing = [];
for (const t of TOOLS) {
  let ep;
  try {
    ep = JSON.parse(readFileSync(path.join(homedir(), `.zcode-${t.tool}-connect`, 'endpoint.json'), 'utf8'));
  } catch (e) {
    console.log(`skip ${t.key}: endpoint.json unreadable (${e.message})`);
    continue;
  }
  let data;
  try {
    const r = await fetch(`http://127.0.0.1:${ep.port ?? t.port}/v1/models`, {
      headers: { authorization: `Bearer ${ep.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = (await r.json()).data ?? [];
  } catch (e) {
    console.log(`skip ${t.key}: /v1/models failed (${e.message})`);
    continue;
  }
  for (const m of data) {
    if (!m?.id) continue;
    const key = `${t.key}/${m.id}`;
    if (Number.isInteger(m.max_output_tokens) && m.max_output_tokens > 0) limits[key] = m.max_output_tokens;
    else missing.push(key);
  }
  console.log(`${t.key}: ${data.length} models`);
}

const outPath = path.join(here, 'model-output-limits.json');
writeFileSync(outPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: 'GET /v1/models on each local endpoint',
  limits,
  undeclared: missing,
}, null, 2)}\n`);
console.log(`wrote ${outPath} (${Object.keys(limits).length} limits, ${missing.length} undeclared)`);
