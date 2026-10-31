#!/usr/bin/env node
/**
 * setup-codex.mjs — 把 zcode-ai-connect 的 Codex 接入写进本机 Codex 配置(幂等)。
 *
 * 背景:Codex 0.142+ 只讲 Responses API(官方已移除 chat/completions),四个端点
 * 只讲 /v1/chat/completions,中间由同目录 codex-responses-bridge.mjs(127.0.0.1:39268)
 * 翻译。本脚本写三处,全部幂等,重跑安全:
 *   1. ~/.codex/config.toml:marker 包裹的 [model_providers.zc-connect](wire_api="responses")
 *   2. ~/.codex/connect-{wb,trae,qoder,qw}.config.toml(profile 文件,0.142+ 独立存放)
 *   3. ~/.codex/hooks.json:SessionStart 追加桥的 ensure(打开 Codex 自动拉起桥)
 *
 * 用法:
 *   node scripts/setup-codex.mjs            # 安装/刷新
 *   node scripts/setup-codex.mjs --remove   # 卸载(只动本脚本写过的东西)
 *
 * 之后:codex --profile connect-wb|-trae|-qoder|-qw;默认 codex 行为不变。
 * 注意:新加的 SessionStart hook 首次在 codex TUI 里会请求一次信任确认,
 * codex exec(非交互)会静默跳过未信任 hook。
 */
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REMOVE = process.argv.includes('--remove');
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const configToml = path.join(codexHome, 'config.toml');
const hooksJson = path.join(codexHome, 'hooks.json');
const bridgeAbs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-responses-bridge.mjs');

const MARK_OPEN = '# >>> zcode-ai-connect >>>';
const MARK_CLOSE = '# <<< zcode-ai-connect <<<';
const ensureCmd = `node ${bridgeAbs.split(path.sep).join('/')} ensure`;

const PROVIDER_BLOCK = `${MARK_OPEN}
# 本地端点经 Responses→Chat 桥接入 Codex(Codex 0.142+ 已移除 wire_api="chat")。
# 桥:scripts/codex-responses-bridge.mjs(127.0.0.1:39268),ensure 子命令自动拉起。
# 模型 id 带提供方前缀:wb/* trae/* qoder/* qw/*;profile 见 connect-*.config.toml。
[model_providers.zc-connect]
name = "zcode-ai-connect (本地桥)"
base_url = "http://127.0.0.1:39268/v1"
wire_api = "responses"
${MARK_CLOSE}`;

// ctx/out 取自各端点 /v1/models 实测值(2026-10-31):四家模型窗口均为 1M;
// codex 无端点元数据可用(fallback 按 128k 假设会过早压缩),须显式声明
const PROFILES = [
  { name: 'connect-wb', model: 'wb/glm-5.3', ctx: 1000000, out: 64000 },
  { name: 'connect-trae', model: 'trae/glm-5.3', ctx: 1000000, out: 32000 },
  { name: 'connect-qoder', model: 'qoder/glm-5.3', ctx: 1000000, out: 32000 },
  { name: 'connect-qw', model: 'qw/qwen3.8-max-preview', ctx: 1000000, out: 32000 },
];

async function backup(file) {
  if (existsSync(file)) {
    await copyFile(file, `${file}.bak-zc-connect`);
  }
}

async function syncConfigToml() {
  const current = existsSync(configToml) ? await readFile(configToml, 'utf8') : '';
  const open = current.indexOf(MARK_OPEN);
  const close = current.indexOf(MARK_CLOSE);
  if (open >= 0 && close > open) {
    // 已有块:原位替换(marker 之外不动)
    const next = current.slice(0, open) + PROVIDER_BLOCK + current.slice(close + MARK_CLOSE.length);
    await writeFile(configToml, next);
    console.log('config.toml: provider 块已刷新(marker 内)');
    return;
  }
  await backup(configToml);
  // 本块全是 [table],追加到文件尾始终是合法 TOML,且不影响既有顶层键
  const next = current.endsWith('\n') || current === '' ? current : current + '\n';
  await writeFile(configToml, `${next}\n${PROVIDER_BLOCK}\n`);
  console.log(`config.toml: provider 块已追加(备份 ${path.basename(configToml)}.bak-zc-connect)`);
}

async function syncProfiles() {
  for (const p of PROFILES) {
    const file = path.join(codexHome, `${p.name}.config.toml`);
    if (REMOVE) {
      if (existsSync(file)) { await rm(file); console.log(`已删除 ${p.name}.config.toml`); }
      continue;
    }
    await writeFile(file, `# zcode-ai-connect:${p.name} 的模型选择。桥由 scripts/codex-responses-bridge.mjs ensure 拉起。
model_provider = "zc-connect"
model = "${p.model}"
model_reasoning_effort = "medium"
model_context_window = ${p.ctx}
model_max_output_tokens = ${p.out}
`);
    console.log(`${p.name}.config.toml: 已写入(model ${p.model}, ctx ${p.ctx}, out ${p.out})`);
  }
}

async function syncHooks() {
  let hooks = { hooks: {} };
  if (existsSync(hooksJson)) {
    try {
      hooks = JSON.parse(await readFile(hooksJson, 'utf8'));
      if (!hooks || typeof hooks !== 'object' || !hooks.hooks) hooks = { hooks: {} };
    } catch {
      console.error(`hooks.json 解析失败,跳过(手动检查 ${hooksJson})`);
      return;
    }
  } else if (REMOVE) {
    return;
  }
  hooks.hooks.SessionStart ??= [];
  const entries = hooks.hooks.SessionStart;
  const hasOurs = entries.some(e => Array.isArray(e?.hooks) && e.hooks.some(h => typeof h?.command === 'string' && h.command.includes('codex-responses-bridge.mjs')));
  if (REMOVE) {
    const before = entries.length;
    hooks.hooks.SessionStart = entries.filter(e => !(Array.isArray(e?.hooks) && e.hooks.some(h => typeof h?.command === 'string' && h.command.includes('codex-responses-bridge.mjs'))));
    if (hooks.hooks.SessionStart.length !== before) {
      await writeFile(hooksJson, JSON.stringify(hooks, null, 2) + '\n');
      console.log('hooks.json: 已移除桥的 SessionStart 条目');
    }
    return;
  }
  if (hasOurs) {
    console.log('hooks.json: 桥的 SessionStart 条目已存在,跳过');
    return;
  }
  await backup(hooksJson);
  entries.push({ hooks: [{ type: 'command', command: ensureCmd, timeout: 15 }] });
  await writeFile(hooksJson, JSON.stringify(hooks, null, 2) + '\n');
  console.log(`hooks.json: SessionStart 已追加桥 ensure(备份 hooks.json.bak-zc-connect)`);
}

if (REMOVE) {
  const current = existsSync(configToml) ? await readFile(configToml, 'utf8') : '';
  const open = current.indexOf(MARK_OPEN);
  const close = current.indexOf(MARK_CLOSE);
  if (open >= 0 && close > open) {
    await writeFile(configToml, current.slice(0, open) + current.slice(close + MARK_CLOSE.length).replace(/^\n+/, ''));
    console.log('config.toml: provider 块已移除');
  } else {
    console.log('config.toml: 未发现 marker 块,跳过');
  }
  await syncProfiles();
  await syncHooks();
  console.log('卸载完成。桥进程如还在跑:node scripts/codex-responses-bridge.mjs status 查看。');
} else {
  await syncConfigToml();
  await syncProfiles();
  await syncHooks();
  console.log('\n完成。用法:codex --profile connect-wb(或 -trae / -qoder / -qw)。');
  console.log('桥需在运行:node scripts/codex-responses-bridge.mjs ensure(hooks.json 已配自动拉起)。');
  console.log('提示:SessionStart hook 首次需在 codex TUI 里确认信任;exec 模式会静默跳过。');
}
