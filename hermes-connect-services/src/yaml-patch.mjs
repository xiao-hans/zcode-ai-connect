/**
 * YAML managed-block patcher — zero dependencies, text-in/text-out.
 *
 * hermes' config.yaml is hand-edited YAML: comments, ordering and quoting all
 * carry meaning for whoever reads it next. A generic YAML round-trip would
 * rewrite the whole file on every sync, so this module does the narrowest
 * thing that can work:
 *
 *   - insert / replace *one block per top-level mapping key*, delimited by a
 *     marker comment pair;
 *   - leave every other byte of the file untouched.
 *
 * Blocks are idempotent: the managed region is torn down and rewritten on each
 * run, so removing a provider from the roster really removes it from the
 * config instead of leaving a stale entry behind.
 *
 * @module hermes-connect-services/src/yaml-patch
 */

const START = (marker) => `# >>> ${marker} >>>`;
const END = (marker) => `# <<< ${marker} <<<`;
/** A child key this suite owns — used to find an orphaned region's real start. */
const OWNS_CHILD = /^\s{0,4}zc-[A-Za-z0-9._-]+\s*:\s*$/;

/**
 * Replace the managed region inside one top-level mapping key.
 *
 * @param {string} text          Whole config file.
 * @param {string} topKey        Top-level mapping key, e.g. `providers`.
 * @param {string} blockBody     Already-indented YAML lines (2 spaces) to host,
 *                               without the parent key itself. `''` removes the
 *                               region and nothing else.
 * @param {{ marker?: string, indent?: string }} [options]
 * @returns {{ text: string, changed: boolean, action: 'inserted'|'replaced'|'removed'|'noop' }}
 */
export function patchManagedBlock(text, topKey, blockBody, options = {}) {
  const marker = options.marker ?? 'zcode-ai-connect';
  const indent = options.indent ?? '  ';
  const startToken = START(marker);
  const endToken = END(marker);

  const lines = text.split(/\r?\n/);
  const keyIndex = findTopLevelKey(lines, topKey);

  if (keyIndex === -1) {
    if (blockBody.trim() === '') return { text, changed: false, action: 'noop' };
    return {
      text: appendKeyBlock(text, topKey, blockBody, { marker, indent }),
      changed: true,
      action: 'inserted',
    };
  }

  // An inline empty map (`providers: {}`) is legal YAML but has nowhere to put
  // children — turn it into a block before patching.
  if (isInlineEmptyMap(lines[keyIndex])) lines[keyIndex] = `${topKey}:`;

  const region = mappingRegion(lines, keyIndex);
  const owned = findManagedRegion(lines, region, startToken, endToken);
  const nextBlock = buildManagedBlock(blockBody, { marker, indent });

  if (owned) {
    const replacement = nextBlock; // '' when the caller wants it gone
    const before = lines.join('\n');
    lines.splice(owned.start, owned.end - owned.start + 1, ...replacement);
    const after = lines.join('\n');
    return {
      text: after,
      // Rewriting an identical region is not a change: callers (and their
      // backups) must not churn just because sync ran twice.
      changed: after !== before,
      action: replacement.length === 0 ? 'removed' : 'replaced',
    };
  }

  if (nextBlock.length === 0) return { text, changed: false, action: 'noop' };
  lines.splice(region.end, 0, ...nextBlock);
  return { text: lines.join('\n'), changed: true, action: 'inserted' };
}

/**
 * Read back what is currently inside one managed region — used by `--diff`
 * reports and by tests. Returns '' when absent.
 */
export function readManagedBlock(text, topKey, options = {}) {
  const marker = options.marker ?? 'zcode-ai-connect';
  const lines = text.split(/\r?\n/);
  const keyIndex = findTopLevelKey(lines, topKey);
  if (keyIndex === -1) return '';
  const region = mappingRegion(lines, keyIndex);
  const owned = findManagedRegion(lines, region, START(marker), END(marker));
  if (!owned) return '';
  return lines.slice(owned.start + 1, owned.end).join('\n');
}

/**
 * Split a managed region into its per-child blocks, keyed by the child's name.
 *
 * Needed for partial syncs (`--only zc-trae`): the region is rewritten whole,
 * so without this the three untouched providers would be dropped on the floor.
 *
 * @returns {Array<{ key: string, body: string }>}
 */
export function readManagedChildren(text, topKey, options = {}) {
  const marker = options.marker ?? 'zcode-ai-connect';
  const lines = text.split(/\r?\n/);
  const keyIndex = findTopLevelKey(lines, topKey);
  if (keyIndex === -1) return [];
  const region = mappingRegion(lines, keyIndex);
  const owned = findManagedRegion(lines, region, START(marker), END(marker));
  if (!owned) return [];
  // Inside `providers:` the region carries the mapping's 2-space indent; strip
  // the common prefix before looking for column-0 child keys.
  return splitBlocks(dedent(lines.slice(owned.start + 1, owned.end)));
}

/** Remove the shortest common leading indent shared by every non-blank line. */
function dedent(lines) {
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
  const shift = indents.length === 0 ? 0 : Math.min(...indents);
  return shift === 0 ? lines : lines.map((line) => (line.trim() === '' ? line : line.slice(shift)));
}

/** True when the top-level mapping key exists at all. */
export function hasTopLevelKey(text, topKey) {
  return findTopLevelKey(text.split(/\r?\n/), topKey) !== -1;
}

// --- internals -------------------------------------------------------------

/** Index of a top-level `key:` line, or -1. Inline keys inside blocks never match. */
function findTopLevelKey(lines, topKey) {
  const escaped = topKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\s*:\\s*(#.*)?$`);
  return lines.findIndex((line) => pattern.test(line));
}

function isInlineEmptyMap(line) {
  return /:\s*\{\s*\}\s*(#.*)?$/.test(line);
}

/**
 * Line range owned by the mapping that starts at `keyIndex`: everything after
 * the key line until the next top-level key (or EOF). Trailing blank lines are
 * excluded so inserted blocks land right after the last real child.
 */
function mappingRegion(lines, keyIndex) {
  let end = lines.length;
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') {
      end = i;
      break;
    }
  }
  while (end - 1 > keyIndex && lines[end - 1].trim() === '') end -= 1;
  return { start: keyIndex + 1, end };
}

/**
 * Locate the managed region inside one mapping.
 *
 * `orphan` covers the case that actually bites in the field: hermes rewrites
 * config.yaml from its own model (GUI model switch, `hermes config set`, …) and
 * drops the opening marker comment while keeping the body and the closing one.
 * Treating that as "no region" makes the next sync insert a second copy of every
 * provider — duplicate top-level keys, and PyYAML silently keeps the last. So an
 * orphan is claimed from its first owned child (`zc-*`) to the stray end marker
 * and rewritten whole. Starting at the child—not at the mapping—is deliberate:
 * a hand-written provider above ours must never be swallowed.
 */
function findManagedRegion(lines, region, startToken, endToken) {
  let start = -1;
  for (let i = region.start; i < region.end; i += 1) {
    if (lines[i].trim() === startToken) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    const endIndex = lines.findIndex((line, i) => i >= region.start && i < region.end && line.trim() === endToken);
    if (endIndex === -1) return null;
    for (let i = region.start; i < endIndex; i += 1) {
      if (OWNS_CHILD.test(lines[i])) return { start: i, end: endIndex, orphan: true };
    }
    return null;
  }
  for (let i = start; i < region.end; i += 1) {
    if (lines[i].trim() === endToken) return { start, end: i };
  }
  // Unterminated marker (hand edit gone wrong) — claim up to the region end so
  // the next sync repairs it deterministically.
  return { start, end: region.end - 1 };
}

function buildManagedBlock(blockBody, { marker, indent }) {
  const body = blockBody.replace(/\s+$/, '');
  if (body === '') return [];
  return [
    `${indent}${START(marker)}`,
    ...body.split('\n').map((line) => (line === '' ? '' : `${indent}${line}`)),
    `${indent}${END(marker)}`,
  ];
}

/**
 * Cut a list of already-dedented lines into top-level blocks. A block starts at
 * a column-0 `key:` line and runs to the next one.
 */
function splitBlocks(body) {
  const blocks = [];
  let current = null;
  for (const line of body) {
    if (/^\S/.test(line) && /^\S[^#]*:\s*$/.test(line)) {
      if (current) blocks.push(current);
      current = { key: line.replace(/:\s*$/, ''), lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks.map(({ key, lines }) => ({
    key,
    body: lines.join('\n').replace(/\s+$/, ''),
  }));
}

function appendKeyBlock(text, topKey, blockBody, { marker, indent }) {
  const head = text.replace(/\s+$/, '');
  const block = buildManagedBlock(blockBody, { marker, indent });
  return [`${head}`, '', `${topKey}:`, ...block, ''].join('\n');
}
