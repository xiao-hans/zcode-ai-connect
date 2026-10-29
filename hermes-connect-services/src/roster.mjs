/**
 * Read each endpoint's live model roster.
 *
 * `/v1/models` is the only source of truth here: the tool's own static catalog
 * files drift (a model can go LOCKED, get renamed, or gain an image input
 * overnight), and the bearer token rotates. Everything the hermes provider
 * entry needs comes from one probe.
 *
 * @module hermes-connect-services/src/roster
 */

import { readEndpoint } from './services.mjs';

/**
 * @param {object} service
 * @returns {Promise<{ baseUrl: string, token: string, port: number, rows: Array<object> }>}
 * @throws when the endpoint is unreachable or answers non-200.
 */
export async function loadRoster(service, { timeoutMs = 5000, attempts = 3, delayMs = 1500 } = {}) {
  const { token, port } = await readEndpoint(service);
  // A sidecar that `ensure` just spawned answers /healthz before its roster is
  // populated; reading once here writes a provider with zero models and hermes
  // then shows nothing under it. Retry the empty answer, not the error.
  let last = { baseUrl: `http://127.0.0.1:${port}/v1`, token, port, rows: [] };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: token === '' ? {} : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`/v1/models -> ${response.status} (端点没跑?先 serve)`);
    }
    const json = await response.json();
    last = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      token,
      port,
      rows: Array.isArray(json?.data) ? json.data : [],
    };
    if (last.rows.length > 0 || attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last;
}

/**
 * Normalise one roster row into what hermes needs.
 *
 * hermes' own picker will happily serve a bare id, but context window,
 * tool-calling and vision are what decide whether a long session survives:
 * get the context window wrong and compression fires halfway through a turn.
 */
export function describe(row, { assumeReasoning = true } = {}) {
  const context = Number.isInteger(row.context_window) && row.context_window > 0
    ? row.context_window
    : undefined;
  const output = Number.isInteger(row.max_output_tokens) && row.max_output_tokens > 0
    ? row.max_output_tokens
    : undefined;
  return {
    id: row.id,
    displayName: row.display_name ?? row.id,
    contextWindow: context,
    maxOutputTokens: output,
    supportsVision: row.supports_images === true,
    // The endpoints forward OpenAI's `reasoning_effort` verbatim, so declaring
    // support is accurate for every model they expose; `--no-reasoning`
    // downgrades the whole provider when a user prefers plain answers.
    supportsReasoning: row.supports_images === false && row.id.startsWith('Doubao-')
      ? false
      : assumeReasoning,
  };
}
