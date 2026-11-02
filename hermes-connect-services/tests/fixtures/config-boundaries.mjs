// Only the CLI's network and process boundaries are replaced; configuration IO is real.
import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const record = (operation) => appendFileSync(process.env.CONFIG_TEST_TRACE, `${operation}\n`);
globalThis.fetch = async (url) => {
  record(`fetch ${url}`);
  if (process.env.CONFIG_TEST_ROSTER === 'offline') throw new Error('fixture endpoint offline');
  return new Response(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 8192 }] }));
};
childProcess.spawn = () => {
  record('spawn');
  throw new Error('tests must not start services');
};
syncBuiltinESMExports();
