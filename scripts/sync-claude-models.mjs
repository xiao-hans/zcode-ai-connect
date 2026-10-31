#!/usr/bin/env node
/**
 * sync-claude-models.mjs — 把四个端点的全量模型名册写进 claude-connect-settings.json
 * 的 modelPicker.options,Claude Code 的 /model 选择器即可列出四家全部模型。
 *
 * 名册来源:各端点 /v1/models(~/.zcode-<工具>-connect/endpoint.json 提供端口),
 * 与 pi 侧 sync-pi-models.mjs 同源。上游名册变化后重跑本脚本即可。
 *
 * 用法:node scripts/sync-claude-models.mjs
 * 前提:四个端点在跑(打开 ZCode 自动拉起,或各插件 cli.mjs serve)。
 * 注意:已开着的 Claude Code 会话要重开才能看到新阵容。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const settingsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-connect-settings.json');

const PROVIDERS = [
  { key: 'wb', tool: 'workbuddy', label: 'WorkBuddy' },
  { key: 'trae', tool: 'trae', label: 'Trae CN' },
  { key: 'qoder', tool: 'qoder', label: 'Qoder CN' },
  { key: 'qw', tool: 'qwenwork', label: '千问办公' },
];

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const defaultModel = settings.env?.ANTHROPIC_MODEL ?? '';

const options = [];
for (const { key, tool, label } of PROVIDERS) {
  let rows = [];
  try {
    const ep = JSON.parse(fs.readFileSync(path.join(os.homedir(), `.zcode-${tool}-connect`, 'endpoint.json'), 'utf8'));
    const r = await fetch(`http://127.0.0.1:${ep.port}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    rows = (await r.json()).data ?? [];
  } catch (e) {
    console.log(`${key}(${tool}): 拉取失败(${e.message}),跳过——端点没在跑?`);
    continue;
  }
  for (const m of rows) {
    if (!m?.id) continue;
    const prefixed = `${key}/${m.id}`;
    const name = m.display_name ?? m.name ?? m.id;
    const star = prefixed === defaultModel ? ' ★' : '';
    options.push({
      model: prefixed,
      label: `${name} · ${label}${star}`,
      behavesAs: 'claude-sonnet-4-6',
    });
  }
  console.log(`${key}(${tool}): ${rows.length} 个模型已收录`);
}

settings.modelPicker = {
  // 内置 Claude 系列经本桥不可用,隐藏默认阵容,只留四家全量模型
  replaceBuiltInOptions: true,
  options,
};

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // 写后自校验
console.log(`\n已写入 ${options.length} 个模型到 ${path.basename(settingsPath)}(默认:${defaultModel || '未设置'})。`);
console.log('已开着的 Claude Code 会话需重开才会看到新阵容。');
