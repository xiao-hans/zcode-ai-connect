#!/usr/bin/env node
/**
 * patch-hermes-stall-gate.mjs — 给 hermes 补一个「宣布下一步却没动手」的续跑闸门。
 *
 * ## 为什么这里必须打补丁，而 ZCode / pi / dsh 不用
 *
 * 另外三端各有一处「回合结束后仍可续跑」的官方钩子点：
 *   ZCode  Stop hook（宿主保证只在一轮零工具调用时触发）
 *   pi     turn_end 返回 {continue:true, entries:[...]}
 *   dsh    agent/turn-stopping 里 agent.steer()
 *
 * hermes 没有。`hermes_cli/plugins.py` 的 VALID_HOOKS 里没有任何「回合正常结束」事件
 * （`agent_loop_stopped` 是 /stop 打断，不是收尾）。唯一能续跑的闸门是 `pre_verify`，
 * 但 `agent/turn_stop_gates.py` 里它的前置条件是 `if _edited and has_hook("pre_verify")`
 * —— 本轮**写过文件**才触发。而「我先检查配置，再修改这里：」这种收尾往往一个工具都
 * 没调，或者只读不写，正好落在门控之外。
 *
 * 所以只能往宿主的收尾闸门链里加第 5 道。改动面刻意压到最小：
 *
 *   agent/turn_stop_gates.py   两个托管块（模块级判定函数 + 一处调用），marker 包围
 *   agent/stall_detector.py    新增文件，判定逻辑本体（从 shared/stall_detector.py 分发）
 *
 * 宿主自带的行一个字节不动，revert 时两条 marker 之间的内容整段删除即可。
 *
 * ## 升级会覆盖
 *
 * hermes 自更新会重置 hermes-agent/ 下的源码，这两个块会一起消失。表现是「续跑不再
 * 发生」而不是报错（模块级 import 有 try/except，文件不在时 `_zc_detect_stall` 为 None，
 * 闸门静默失效）。升级后重跑本脚本即可恢复 —— `--check` 会告诉你当前状态。
 *
 * @module patch-hermes-stall-gate
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '';
const MARKER = 'zcode-ai-connect stall-guard';
const START = `# >>> ${MARKER} >>>`;
const END = `# <<< ${MARKER} <<<`;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const options = {
  check: has('--check'),
  revert: has('--revert'),
  dryRun: has('--dry-run'),
  verbose: has('--verbose') || has('-v'),
  home: valueOf('--home') ?? process.env.HERMES_HOME ?? null,
};

/** hermes 的 home：Windows 是 %LOCALAPPDATA%/hermes，其他地方是 ~/.hermes。 */
function locateHome() {
  const candidates = [
    options.home,
    process.env.HERMES_HOME,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hermes') : null,
    join(HOME, '.hermes'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, 'config.yaml'))) ?? null;
}

/** 运行时的源码树。installs/<id>/environments/<id>/workspace 是项目沙箱副本，不是主进程加载的那份。 */
function locateAgentRoot(home) {
  const candidates = [
    join(home, 'hermes-agent'),
    join(HOME, '.hermes', 'hermes-agent'),
  ];
  return candidates.find((p) => existsSync(join(p, 'agent', 'turn_stop_gates.py'))) ?? null;
}

/** 找 hermes 自带的解释器，用来做语法检查。 */
function findPython(home) {
  const candidates = [
    process.env.HERMES_PYTHON,
    join(home, 'tools', `python-3.14.9+20261021-win32-x64`, 'python.exe'),
    'python',
    'python3',
  ].filter(Boolean);
  for (const exe of candidates) {
    const probe = spawnSync(exe, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 15000 });
    if (probe.status === 0 && probe.stdout.trim() === '1') return exe;
  }
  return null;
}

const MODULE_BLOCK = (source) => [
  START,
  '# 由 hermes-connect-services/bin/patch-hermes-stall-gate.mjs 写入 —— 勿手改。',
  '#',
  '# 第 5 道收尾闸：模型只宣布下一步、本轮零工具调用就结束，追加一条 user 提示把本轮续上。',
  '# 判定逻辑在 agent/stall_detector.py，与 ZCode / pi / dsh 三端同一套规则。',
  'import hashlib as _zc_hashlib',
  '',
  '# 一个会话内最多续跑几次。与三端一致：连续 3 次都唤不醒，再提示也只是复读计划。',
  '_ZC_STALL_MAX_NUDGES = 3',
  '',
  'try:',
  '    from agent.stall_detector import detect_stall as _zc_detect_stall',
  'except Exception:  # 升级后 stall_detector.py 可能不在：静默降级，绝不阻断正常结束',
  '    _zc_detect_stall = None',
  '',
  '',
  'def _zc_stall_guard_enabled() -> bool:',
  '    env = os.environ.get("HERMES_STALL_GUARD")',
  '    if env is not None:',
  '        return env.strip().lower() not in {"0", "false", "off", "no", "disabled"}',
  '    try:',
  '        from hermes_cli.config import load_config_readonly',
  '',
  '        cfg = (load_config_readonly() or {}).get("agent") or {}',
  '    except Exception:',
  '        return True',
  '    value = cfg.get("stall_guard", True)',
  '    if isinstance(value, bool):',
  '        return value',
  '    return str(value).strip().lower() not in {"0", "false", "off", "no", "disabled"}',
  '',
  '',
  'def _zc_tool_calls_this_turn(messages) -> int:',
  '    """本轮（最后一条 user 消息之后）发出的 tool_call 总数。',
  '',
  '    与 ZCode 侧的 toolCallCount 同义：> 0 就不存在「只说不做」。',
  '    """',
  '    start = 0',
  '    for i in range(len(messages) - 1, -1, -1):',
  '        msg = messages[i]',
  '        if isinstance(msg, dict) and msg.get("role") == "user":',
  '            start = i + 1',
  '            break',
  '    total = 0',
  '    for msg in messages[start:]:',
  '        if not isinstance(msg, dict):',
  '            continue',
  '        calls = msg.get("tool_calls")',
  '        if isinstance(calls, list):',
  '            total += len(calls)',
  '    return total',
  '',
  '',
  'def _zc_stall_guard_nudge(agent, messages, final_response):',
  '    """命中则返回要回灌的提示，否则 None。',
  '',
  '    收尾闸门里抛异常会打断本轮的正常结束，所以整个函数是 fail-open 的。',
  '    """',
  '    try:',
  '        if _zc_detect_stall is None or not _zc_stall_guard_enabled():',
  '            return None',
  '        text = final_response if isinstance(final_response, str) else ""',
  '        if not text.strip():',
  '            return None',
  '        digest = _zc_hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()',
  '        seen = getattr(agent, "_zc_stall_guard_seen", None)',
  '        if not isinstance(seen, list):',
  '            seen = []',
  '        if digest in seen or len(seen) >= _ZC_STALL_MAX_NUDGES:',
  '            return None',
  '        verdict = _zc_detect_stall(text, _zc_tool_calls_this_turn(messages))',
  '        if not isinstance(verdict, dict) or not verdict.get("stall"):',
  '            return None',
  '        agent._zc_stall_guard_seen = seen + [digest]',
  '        logger.debug(',
  '            "stall-guard matched (verdict=%s score=%s signals=%s)",',
  '            verdict.get("verdict"), verdict.get("score"), verdict.get("signals"),',
  '        )',
  '        return verdict.get("prompt")',
  '    except Exception:',
  '        logger.debug("stall-guard check failed", exc_info=True)',
  '        return None',
  END,
].join('\n');

const CALL_BLOCK = [
  `    ${START}`,
  '    # 放在最后一道：前面的闸门（late-LSP / verify-on-stop / pre_verify / kanban）',
  '    # 已经各自 return 了，走到这里说明没有别的理由继续这一轮。',
  '    _zc_nudge = _zc_stall_guard_nudge(agent, messages, final_response)',
  '    if _zc_nudge:',
  '        final_msg["finish_reason"] = "stall_guard_continue"',
  '        _append_interim_answer(',
  '            agent, final_msg, messages, conversation_history, "stall-guard interim flush failed"',
  '        )',
  '        logger.debug(',
  '            "stall-guard nudge issued (%d/%d)",',
  '            len(getattr(agent, "_zc_stall_guard_seen", []) or []),',
  '            _ZC_STALL_MAX_NUDGES,',
  '        )',
  '        return _continue(_zc_nudge, "_zc_stall_guard_synthetic")',
  `    ${END}`,
].join('\n');

/**
 * 删掉**所有** marker 块。
 *
 * 必须按整行删除：调用块是缩进在函数体里的，若只从 `#` 开始切，会留下那 4 个
 * 空格残行，导致结果变成 `            return StopGateVerdict(`（12 空格）—— 语法
 * 合法但缩进错误，Python 会把它当缩进块的一部分。所以按行首/行尾切。
 */
function stripBlock(text) {
  let lines = text.split('\n');
  for (;;) {
    const s = lines.findIndex((line) => line.includes(START));
    if (s === -1) break;
    let e = lines.findIndex((line, i) => i > s && line.includes(END));
    if (e === -1) break;
    lines.splice(s, e - s + 1);
    // 块两侧原本各有一个空行分隔；删完如果两边都是空行，会多出一个。
    if (lines[s - 1] !== undefined && lines[s] !== undefined
      && lines[s - 1].trim() === '' && lines[s].trim() === '') {
      lines.splice(s, 1);
    }
  }
  return lines.join('\n');
}

/** 锚点必须唯一，否则宁可报错也不猜。 */
function assertUniqueAnchor(text, anchor, label) {
  const first = text.indexOf(anchor);
  if (first === -1) throw new Error(`找不到插入锚点: ${label}`);
  if (text.indexOf(anchor, first + 1) !== -1) throw new Error(`插入锚点不唯一: ${label}`);
  return first;
}

function main() {
  const home = locateHome();
  if (!home) {
    console.error('找不到 hermes home（可设 HERMES_HOME 或用 --home 指定）');
    process.exit(1);
  }
  const agentRoot = locateAgentRoot(home);
  if (!agentRoot) {
    console.error(`找不到 ${join(home, 'hermes-agent')}/agent/turn_stop_gates.py`);
    process.exit(1);
  }

  const gatePath = join(agentRoot, 'agent', 'turn_stop_gates.py');
  const detectorPath = join(agentRoot, 'agent', 'stall_detector.py');
  const sourceDetector = join(PKG_ROOT, 'lib', 'stall_detector.py');

  if (!existsSync(sourceDetector)) {
    console.error(`包里缺 lib/stall_detector.py —— 先在仓库根跑 node scripts/sync-stall-guard.mjs`);
    process.exit(1);
  }

  let gate = readFileSync(gatePath, 'utf8');
  const patched = gate.includes(START);
  const detectorPresent = existsSync(detectorPath);

  if (options.check) {
    console.log(`home:       ${home}`);
    console.log(`gate file:  ${gatePath}`);
    console.log(`patched:    ${patched ? 'yes' : 'no'}`);
    console.log(`detector:   ${detectorPresent ? 'yes' : 'no'}`);
    if (patched && detectorPresent) {
      const same = readFileSync(detectorPath, 'utf8') === readFileSync(sourceDetector, 'utf8');
      console.log(`detector in sync: ${same ? 'yes' : 'NO (重跑本脚本)'}`);
      if (!same) process.exit(2);
    } else {
      process.exit(2);
    }
    return;
  }

  if (options.revert) {
    if (!patched && !detectorPresent) {
      console.log('没有需要撤销的改动');
      return;
    }
    if (options.dryRun) {
      console.log(`--dry-run: 会移除 ${gatePath} 的托管块${detectorPresent ? ' 与 stall_detector.py' : ''}`);
      return;
    }
    const bakPath = `${gatePath}.bak-zcode-stall-guard`;
    // 首次打补丁时留下的原始快照优先 —— 它比"按 marker 反删"更能保证零字节还原。
    const bakIsPristine = existsSync(bakPath) && !readFileSync(bakPath, 'utf8').includes(START);
    if (bakIsPristine) {
      copyFileSync(bakPath, gatePath);
      console.log(`  从原始快照恢复 ${bakPath}`);
    } else {
      writeFileSync(gatePath, stripBlock(gate), 'utf8');
    }
    if (detectorPresent) {
      const current = readFileSync(detectorPath, 'utf8');
      if (current === readFileSync(sourceDetector, 'utf8')) {
        unlinkSync(detectorPath);
      } else {
        console.log(`stall_detector.py 已被改动过，保留不删: ${detectorPath}`);
      }
    }
    console.log(`已撤销${bakIsPristine ? '' : `（备份: ${bakPath}）`}`);
    return;
  }

  // ── 应用补丁（幂等：先清旧块再按锚点插新块） ─────────────────────────────
  gate = stripBlock(gate);

  const moduleAnchor = '\ndef _verify_on_stop_nudge(agent) -> Optional[str]:';
  const callAnchor = '\n    return StopGateVerdict(\n        continue_turn=False, final_response=final_response,';

  const moduleAt = assertUniqueAnchor(gate, moduleAnchor, 'def _verify_on_stop_nudge');
  gate = `${gate.slice(0, moduleAt)}\n${MODULE_BLOCK()}\n${gate.slice(moduleAt)}`;

  const callAt = assertUniqueAnchor(gate, callAnchor, 'return StopGateVerdict(continue_turn=False');
  gate = `${gate.slice(0, callAt)}\n${CALL_BLOCK}\n${gate.slice(callAt)}`;

  if (options.dryRun) {
    console.log(`--dry-run: 会给 ${gatePath} 插入 ${START} / ${END} 两块`);
    if (options.verbose) console.log(MODULE_BLOCK().split('\n').slice(0, 4).join('\n'));
    return;
  }

  // 只有在文件还是原样时才留快照。重打补丁时覆盖快照，会让 --revert 失去干净的回退点。
  if (!patched) copyFileSync(gatePath, `${gatePath}.bak-zcode-stall-guard`);
  writeFileSync(gatePath, gate, 'utf8');
  mkdirSync(dirname(detectorPath), { recursive: true });
  writeFileSync(detectorPath, readFileSync(sourceDetector, 'utf8'), 'utf8');

  // ── 语法检查：补丁后宿主必须仍然可 import ─────────────────────────────────
  const python = findPython(home);
  if (python) {
    const check = spawnSync(python, ['-m', 'py_compile', gatePath, detectorPath], {
      encoding: 'utf8', timeout: 60000, cwd: agentRoot,
    });
    if (check.status !== 0) {
      copyFileSync(`${gatePath}.bak-zcode-stall-guard`, gatePath);
      console.error('语法检查失败，已回滚:');
      console.error((check.stderr || check.stdout || '').slice(0, 1200));
      process.exit(1);
    }
    console.log(`  syntax ok (${python})`);
  } else {
    console.log('  (没找到 python，跳过语法检查)');
  }

  console.log(`  patched ${gatePath}`);
  console.log(`  wrote   ${detectorPath}`);
  console.log('');
  console.log('生效需要重启 hermes gateway —— 已 import 的模块不会自动重载。');
}

main();
