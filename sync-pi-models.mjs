#!/usr/bin/env node
/**
 * sync-pi-models.mjs — 把 zcode-trae-connect / zcode-workbuddy-connect 的本地端点
 * 同步进 pi 的 ~/.pi/agent/models.json。
 *
 * - 只覆盖 providers.trae 和 providers.workbuddy 两个键,其他 provider(opencode-go 等)原样保留。
 * - 模型清单来自端点实时 /v1/models(含 contextWindow / maxTokens / 图像支持)。
 * - 推理档位:WorkBuddy 取 src/catalog.js 的 reasoning 行(wire 值恰为 pi 的 low..max);
 *   Trae 取 `cli.mjs status` 文本里的 efforts 列(wire 值 light/high/extra_high,
 *   映射 light=low、high=medium、extra_high=max;未声明的档位不映射,服务端回退默认)。
 * - LOCKED(未解锁)模型跳过。上游名单变了重跑本脚本即可。
 *
 * 前提:两个端点在跑(zcode-*-connect 的 serve / SessionStart hook)。
 * 用法:node sync-pi-models.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const home = os.homedir();
const MODELS_PATH = path.join(home, '.pi', 'agent', 'models.json');
// 工具根目录 = 本脚本所在目录(套件仓库根);环境变量可覆盖。
const SUITE_ROOT = process.env.AI_CONNECT_SUITE_ROOT
  ?? path.dirname(fileURLToPath(import.meta.url));
const TRAE_DIR = path.join(SUITE_ROOT, 'zcode-trae-connect');
const WB_DIR = path.join(SUITE_ROOT, 'zcode-workbuddy-connect');
const QODER_DIR = path.join(SUITE_ROOT, 'zcode-qoder-connect');

const PI_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const WB_EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
// pi level → trae wire 档位偏好列表(取第一个被该模型声明的档位)。
// llm_utils_chat 通道的档位是 low/medium/high/xhigh;旧 chat_sessions 通道
// 是 light/high/extra_high——两套拼写都兼容。
const TRAE_CANDIDATES = {
  minimal: ['low', 'light'],
  low: ['low', 'light'],
  medium: ['medium', 'high'],
  high: ['high'],
  xhigh: ['xhigh', 'extra_high', 'high', 'max'],
  max: ['max', 'xhigh', 'extra_high', 'high'],
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

async function endpointRoster(stateDir) {
  const ep = readJson(path.join(home, stateDir, 'endpoint.json'));
  const res = await fetch(`http://127.0.0.1:${ep.port}/v1/models`, {
    headers: { Authorization: `Bearer ${ep.token}` },
  });
  if (!res.ok) throw new Error(`${stateDir}: /v1/models -> ${res.status}(端点没跑?先 serve)`);
  const j = await res.json();
  return { baseUrl: `http://127.0.0.1:${ep.port}/v1`, apiKey: ep.token, rows: j.data ?? [] };
}

/** trae status 文本(国内版 section) -> [{id, efforts, usable}] */
function traeCatalogFromStatus() {
  const out = execSync(`node "${TRAE_DIR}/bin/cli.mjs" status`, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const cn = out.split('=== Trae 国际版 ===')[0];
  const models = [];
  for (const line of cn.split('\n')) {
    const m = line.match(/^\s{4}(\S+)\s+.*?\s{2,}(\d+) ctx\s+(.+)$/);
    if (!m) continue;
    const [, id, , rest] = m;
    const parts = rest.split('·').map((s) => s.trim());
    const effortPart = parts.find((p) => p.startsWith('efforts '));
    // `max N` 后缀 = Trae 目录声明的 max 模式窗口(仅 max_mode 模型带)。
    const maxWindow = Number(rest.match(/max (\d+)/)?.[1]) || undefined;
    models.push({
      id,
      usable: parts[0] === 'usable',
      efforts: effortPart ? effortPart.slice('efforts '.length).split('/').filter(Boolean) : [],
      maxWindow,
    });
  }
  return models;
}

/** workbuddy catalog.js -> Map(id -> {supports, efforts}) */
function wbCatalog() {
  const text = fs.readFileSync(path.join(WB_DIR, 'src', 'catalog.js'), 'utf8');
  const map = new Map();
  for (const line of text.split('\n')) {
    const id = line.match(/id:\s*'([^']+)'/)?.[1];
    if (!id) continue;
    const supports = /[^a-zA-Z]supports:\s*true/.test(line);
    const efforts = [];
    const list = line.match(/supportedEfforts:\s*\[([^\]]*)\]/)?.[1];
    if (list) {
      efforts.push(...list.split(',').map((s) => s.trim().replaceAll("'", '')).filter(Boolean));
    } else {
      const def = line.match(/defaultEffort:\s*'([^']+)'/)?.[1];
      if (def) efforts.push(def);
    }
    map.set(id, { supports, efforts });
  }
  return map;
}

/**
 * workbuddy `cli.mjs status` 文本(cn section)-> Map(id -> efforts[])。
 * 实时 roster 是档位的权威来源;src/catalog.js 是会过时的静态快照
 * (例如 deepseek-v4.1-flash 静态标 supports:false,实时却声明 low/high/max 三档)。
 */
function wbEffortsFromStatus() {
  const out = execSync(`node "${WB_DIR}/bin/cli.mjs" status`, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const cn = out.split('=== WorkBuddy AI')[0];
  const map = new Map();
  for (const line of cn.split('\n')) {
    const m = line.match(/^\s{4}(\S+)\s+.*?\s{2,}(\d+) ctx\s+(.+)$/);
    if (!m) continue;
    const effortPart = m[3].split('·').map((s) => s.trim()).find((p) => p.startsWith('efforts '));
    if (effortPart) map.set(m[1], effortPart.slice('efforts '.length).split('/').filter(Boolean));
  }
  return map;
}

/** 声明档位里挑离 pi level 最近的;平手取更低档 */
function nearestEffort(level, efforts, rank) {
  if (efforts.includes(level)) return level;
  const li = rank[level];
  if (li === undefined) return undefined;
  let best;
  let bestDist = Infinity;
  for (const e of efforts) {
    const d = Math.abs((rank[e] ?? -99) - li);
    if (d < bestDist || (d === bestDist && (rank[e] ?? 0) < (rank[best] ?? -99))) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

const inputFor = (images) => (images ? ['text', 'image'] : ['text']);

// ---- trae ----
const traeEp = await endpointRoster('.zcode-trae-connect');
const traeStatus = traeCatalogFromStatus();
const traeById = new Map(traeStatus.map((m) => [m.id, m]));
const traeModels = [];
let traeSkipped = 0;
for (const row of traeEp.rows) {
  const st = traeById.get(row.id);
  if (st && !st.usable) {
    traeSkipped++;
    continue;
  }
  const efforts = st?.efforts ?? [];
  const reasoning = efforts.length > 0;
  const model = {
    id: row.id,
    name: 'Trae · ' + (row.display_name || row.id),
    reasoning,
    input: inputFor(row.supports_images),
    // serve 进程默认开启 max 模式(cli.js preferences),请求按 max 窗口发出,
    // 但端点 /v1/models 只报 dev 窗口(server.js 固定用 model.contextWindow)。
    // max_mode 模型按实际生效的 max 窗口上报,避免 pi 过早压缩上下文。
    contextWindow:
      st?.maxWindow && st.maxWindow > row.context_window ? st.maxWindow : row.context_window,
    maxTokens: row.max_output_tokens,
  };
  if (reasoning) {
    const tlm = { off: null };
    for (const level of PI_LEVELS) {
      const prefs = TRAE_CANDIDATES[level] ?? [level];
      const target = prefs.find((p) => efforts.includes(p));
      if (target) tlm[level] = target;
    }
    model.thinkingLevelMap = tlm;
  }
  traeModels.push(model);
}

// ---- workbuddy ----
const wbEp = await endpointRoster('.zcode-workbuddy-connect');
const wbCat = wbCatalog();
const wbEfforts = wbEffortsFromStatus();
const wbModels = [];
for (const row of wbEp.rows) {
  const cat = wbCat.get(row.id);
  const efforts = wbEfforts.get(row.id) ?? [];
  // 多档声明 = 可控推理;单档但 catalog 明确 supports:true(如 hy4-preview)也算,
  // 档位固定映射到那一档。单档且 supports:false = 上游写死 effort,不可调。
  const reasoning = efforts.length > 1 || cat?.supports === true;
  const model = {
    id: row.id,
    name: 'WB · ' + (row.display_name || row.id),
    reasoning,
    input: inputFor(row.supports_images),
    contextWindow: row.context_window,
    maxTokens: row.max_output_tokens,
  };
  if (reasoning) {
    const tlm = { off: null };
    if (efforts.length > 1) {
      for (const level of PI_LEVELS) {
        const target = nearestEffort(level, efforts, WB_EFFORT_RANK);
        if (target) tlm[level] = target;
      }
    } else {
      const fixed = efforts[0] ?? cat?.efforts?.[0];
      if (fixed) for (const level of PI_LEVELS) tlm[level] = fixed;
    }
    model.thinkingLevelMap = tlm;
  }
  wbModels.push(model);
}

/** qoder `cli.mjs status` 文本 -> Map(内部key -> efforts[])。行首缩进两空格;
 * 行内无 · 分隔符;档位词表本身就是 pi 的 low/medium/high/xhigh/max。 */
function qoderEffortsFromStatus() {
  const out = execSync(`node "${QODER_DIR}/bin/cli.mjs" status`, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^ {2}(\S+)\s+.*?\s{2,}(\d+) ctx\s*(.*)$/);
    if (!m) continue;
    const effortMatch = m[3].match(/efforts ([^\n]+?)(?:\s{2,}x[\d.]+)?\s*$/);
    if (effortMatch) map.set(m[1], effortMatch[1].split('/').filter(Boolean));
  }
  return map;
}

/** 服务端 /v1/models 对外用别名 id;档位表按内部 key 建,这里反向解出。 */
const QODER_ALIAS_TO_INTERNAL = {
  'qoder-auto': 'auto',
  'qoder-fast': 'fast',
  'qwen3.8-max': 'qmodel_38max',
  'qwen3.8-flash': 'qfmodel',
  'deepseek-v4-pro': 'dmodel',
  'deepseek-flash': 'dfmodel',
  'glm-5.3': 'gmodel',
  'glm-5.3-flash': 'gfmodel',
  'kimi-k3.1-pro': 'kmodel_latest',
  'kimi-k2.8-preview': 'kmodel',
  'minimax-m3.1-flash': 'mmodel',
}

// ---- qoder ----
// 端点不可达(服务没跑/没凭据)时整体跳过,不视为错误。
let qoderEp = null;
try {
  qoderEp = await endpointRoster('.zcode-qoder-connect');
} catch {
  console.log('qoder:     端点不可达,跳过(如需启用: node ' + QODER_DIR + '/bin/cli.mjs serve)');
}
let qoderModels = [];
if (qoderEp) {
  const qoderEfforts = qoderEffortsFromStatus();
  for (const row of qoderEp.rows) {
    if (row.id === 'qoder-auto') continue;
    const internalKey = QODER_ALIAS_TO_INTERNAL[row.id] ?? row.id;
    const efforts = qoderEfforts.get(internalKey) ?? [];
    const reasoning = efforts.length > 0;
    const model = {
      id: row.id,
      name: 'Qoder · ' + (row.display_name || row.id),
      reasoning,
      input: inputFor(row.supports_images),
      contextWindow: row.context_window,
      maxTokens: row.max_output_tokens,
    };
    if (reasoning) {
      const tlm = { off: null };
      for (const level of PI_LEVELS) {
        if (efforts.includes(level)) tlm[level] = level;
      }
      model.thinkingLevelMap = tlm;
    }
    qoderModels.push(model);
  }
}

// ---- merge + write ----
fs.copyFileSync(MODELS_PATH, MODELS_PATH + '.bak');
const config = readJson(MODELS_PATH);
config.providers ??= {};
config.providers.trae = {
  name: 'Trae (CN)',
  baseUrl: traeEp.baseUrl,
  apiKey: traeEp.apiKey,
  api: 'openai-completions',
  models: traeModels,
};
config.providers.workbuddy = {
  name: 'WorkBuddy',
  baseUrl: wbEp.baseUrl,
  apiKey: wbEp.apiKey,
  api: 'openai-completions',
  models: wbModels,
};
if (qoderEp && qoderModels.length > 0) {
  config.providers.qoder = {
    name: 'Qoder (CN)',
    baseUrl: qoderEp.baseUrl,
    apiKey: qoderEp.apiKey,
    api: 'openai-completions',
    models: qoderModels,
  };
} else {
  delete config.providers.qoder;
}
fs.writeFileSync(MODELS_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');

// ---- report(不打印 apiKey)----
console.log(`trae:       ${traeModels.length} models @ ${traeEp.baseUrl}(跳过 LOCKED ${traeSkipped})`);
console.log(`workbuddy:  ${wbModels.length} models @ ${wbEp.baseUrl}`);
if (qoderEp) console.log(`qoder:     ${qoderModels.length} models @ ${qoderEp.baseUrl}`);
console.log('providers now:', Object.keys(config.providers).join(', '));
console.log('backup written:', MODELS_PATH + '.bak');
