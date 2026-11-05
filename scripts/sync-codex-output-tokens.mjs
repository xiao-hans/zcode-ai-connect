// 按每个模型的真实 max_output_tokens 对齐 Codex 配置,避免:
//   - 配太大 -> 桥夹到模型上限,Codex 记账与实际脱节;
//   - 配太小 -> 单轮稍长就 finish_reason:"length",报
//     "Incomplete response returned, reason: max_output_tokens"。
// 数据来源:scripts/model-output-limits.json(由 sync-model-output-limits.mjs 生成)。
// 用法: node scripts/sync-codex-output-tokens.mjs [--dry-run]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codexDir = path.join(homedir(), '.codex');
const dry = process.argv.includes('--dry-run');
const limits = JSON.parse(readFileSync(path.join(here, 'model-output-limits.json'), 'utf8')).limits ?? {};

// 端点 roster 未声明输出上限时,按前缀的保守值
const PREFIX_FALLBACK = { wb: 32000, trae: 32000, qoder: 32000, qw: 32000 };
function limitFor(model) {
  if (Number.isInteger(limits[model]) && limits[model] > 0) return limits[model];
  return PREFIX_FALLBACK[model?.split('/')[0]] ?? 32000;
}

const files = ['config.toml', ...readdirSync(codexDir).filter(f => /^connect-.*\.config\.toml$/.test(f))];
for (const file of files) {
  const full = path.join(codexDir, file);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, 'utf8');
  const match = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(text);
  if (!match) { console.log(`skip ${file}: no model line`); continue; }
  const model = match[1];
  const cap = limitFor(model);
  const hasKey = /^\s*model_max_output_tokens\s*=/m.test(text);
  const next = hasKey
    ? text.replace(/^(\s*model_max_output_tokens\s*=\s*)\d+/m, `$1${cap}`)
    : `${text.replace(/\s*$/, '')}\nmodel_max_output_tokens = ${cap}\n`;
  const old = /^\s*model_max_output_tokens\s*=\s*(\d+)/m.exec(text)?.[1] ?? '(unset)';
  console.log(`${file.padEnd(30)} model=${model.padEnd(30)} ${old} -> ${cap}${dry ? ' (dry-run)' : ''}`);
  if (!dry && next !== text) writeFileSync(full, next);
}
