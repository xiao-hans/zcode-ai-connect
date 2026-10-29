#!/usr/bin/env node
/**
 * ensure-services.mjs — bring the four loopback endpoints up if they are down.
 *
 * This is the hermes-side half of the suite's launch-on-open design: each
 * plugin expects something to be listening on its fixed port before the first
 * message goes out, because the provider entry in hermes' config.yaml points
 * at that port.
 *
 * It is installed as a hermes shell hook on `on_session_start` (see
 * `--install-hooks` on sync-hermes-config.mjs) and it is safe to run by hand.
 *
 * Contract with hermes' shell-hook runner:
 *   - stdin receives a JSON payload → drain it so nothing blocks;
 *   - stdout must be empty or a JSON object → we print diagnostics to stderr
 *     only, so `--verbose` debugging never risks being parsed as a directive;
 *   - always exits 0 — a hook that fails the session because it could not
 *     start a sidecar would be worse than no hook.
 *
 * Usage:
 *   node ensure-services.mjs [--verbose] [--only zc-trae]
 */

import { SERVICES, ensure, log } from '../src/services.mjs';

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose') || argv.includes('-v');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const targets = only ? SERVICES.filter((s) => s.id === only || s.tool === only) : SERVICES;

const say = (line) => process.stderr.write(`${line}\n`);

// hermes writes a hook payload to stdin; nothing here reads it, but leaving it
// undrained risks a full pipe on some platforms.
process.stdin.resume().on('data', () => {});

if (targets.length === 0) {
  say(`[hermes-connect-services] unknown --only target: ${only}`);
  process.exit(0);
}

const results = await Promise.all(targets.map(async (service) => {
  const result = await ensure(service);
  await log(service, `[hermes] ensure: ${result.action}${result.up ? '' : ` (not reachable on :${result.port})`}`);
  return result;
}));

if (verbose) {
  say('[hermes-connect-services]');
  for (const r of results) say(`  ${r.service.id.padEnd(13)} :${r.port}  ${r.up ? 'up  ' : 'DOWN'}  ${r.action}`);
} else {
  const down = results.filter((r) => !r.up);
  if (down.length > 0) {
    say(`[hermes-connect-services] ${down.length}/${results.length} endpoint(s) unreachable: ${down.map((r) => r.service.id).join(', ')}`);
    say('  Their models will fail until started. Start one manually with:');
    for (const r of down) say(`    node "${import.meta.dirname}/../../${r.service.tool}/bin/cli.mjs" serve --port ${r.port}`);
    say('  ...or re-run this script with --verbose.');
  }
}

process.exit(0);
