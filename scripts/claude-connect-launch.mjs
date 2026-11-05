#!/usr/bin/env node
/**
 * claude-connect.cmd 的启动器。
 *
 * Claude Code 读 --settings 里的 ANTHROPIC_AUTH_TOKEN,并且这份 env 压过 shell。
 * 仓库里的 claude-connect-settings.json 只放占位符 zc-connect-local(不是密钥)。
 * 这里复制一份临时 settings,把桥的本机 bearer 填进去。
 * claude-connect.cmd 用 --emit-settings 取路径,自己启动 claude(参数仍由 cmd 引用)。
 * 直接运行本文件则会代为启动 claude。不改 ~/.claude,也不改仓库里的 settings。
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(here, 'claude-connect-settings.json');
const bridgePath = path.join(here, 'codex-responses-bridge.mjs');

export function settingsForLaunch(settings, token) {
  const next = structuredClone(settings);
  next.env ??= {};
  next.env.ANTHROPIC_AUTH_TOKEN = token;
  return next;
}

export function readBridgeToken() {
  const result = spawnSync(process.execPath, [bridgePath, 'token'], { encoding: 'utf8' });
  const token = (result.stdout ?? '').trim();
  if (result.status !== 0 || token === '') {
    throw new Error((result.stderr || '无法读取桥的本机 bearer').trim());
  }
  return token;
}

function writeLaunchSettings() {
  const token = readBridgeToken();
  const settings = settingsForLaunch(JSON.parse(readFileSync(settingsPath, 'utf8')), token);
  const file = path.join(tmpdir(), `zc-claude-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* 尽力而为 */ }
  return file;
}

function cleanup(file) {
  try { rmSync(file, { force: true }); } catch { /* 临时文件尽力删除 */ }
}

function main() {
  const emit = process.argv.includes('--emit-settings');
  const file = writeLaunchSettings();
  // claude-connect.cmd 自己启动 claude 并在退出后删除这份文件,这样参数仍由 cmd 引用,
  // 路径里的空格不会被 shell 再切一次。
  if (emit) {
    process.stdout.write(`${file}\n`);
    return;
  }
  const args = process.argv.slice(2).filter((arg) => arg !== '--emit-settings');
  const child = spawn('claude', ['--settings', file, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  child.on('error', (error) => {
    console.error(error.message);
    cleanup(file);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    cleanup(file);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
