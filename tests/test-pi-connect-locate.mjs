/**
 * Regression tests for pi-connect-services' tool lookup.
 *
 * The lookup is what makes `pi install npm:pi-connect-services` work without
 * any configuration — a tool that ships neither `main` nor `exports` cannot be
 * resolved through the package entry and must still be found.
 *
 *   node tests/test-pi-connect-locate.mjs
 */

import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUITE_ROOT = dirname(HERE)
const MODULE = new URL('../pi-connect-services/index.js', import.meta.url).href
const TOOLS = ['zcode-qoder-connect', 'zcode-workbuddy-connect', 'zcode-trae-connect']

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}  ${detail}`)
  }
}

const { locateTool, default: extension } = await import(MODULE)
check('module exports the extension default', typeof extension === 'function')
check('module exports locateTool', typeof locateTool === 'function')

// 1) Monorepo checkout, no env: the sibling layout must be used.
process.env.PI_CONNECT_TOOLS_ROOT = ''
console.log('\n[1] monorepo checkout, no env')
for (const tool of TOOLS) {
  const found = locateTool(tool)
  check(`${tool} located`, !!found && existsSync(join(found.dir, 'bin', 'cli.mjs')), found?.via)
  check(`${tool} is the repo sibling`, found?.dir === join(SUITE_ROOT, tool), found?.dir ?? 'null')
}

// 2) Env override wins over everything else.
process.env.PI_CONNECT_TOOLS_ROOT = SUITE_ROOT
console.log('\n[2] PI_CONNECT_TOOLS_ROOT set')
for (const tool of TOOLS) {
  const found = locateTool(tool)
  check(`${tool} via env`, found?.via === 'PI_CONNECT_TOOLS_ROOT', found?.via ?? 'null')
}

// 3) An env root that does not hold the tools must fall back, not return it.
const bogus = join(tmpdir(), 'zc-locate-bogus-root')
mkdirSync(bogus, { recursive: true })
process.env.PI_CONNECT_TOOLS_ROOT = bogus
console.log('\n[3] env points at an empty root -> falls back')
const fallback = locateTool(TOOLS[0])
check('did not return the bogus dir', !!fallback && fallback.dir !== bogus, fallback?.via ?? 'null')

// 4) Unresolvable tool -> null, so the caller can warn instead of failing silently.
console.log('\n[4] unknown tool -> null')
check('returns null', locateTool('zcode-nope-connect') === null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
