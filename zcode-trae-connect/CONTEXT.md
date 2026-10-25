# zcode-trae-connect

**Trae** — the models in the Trae desktop app, exposed to ZCode as
OpenAI-compatible model providers. A port of `marsma-101/dsh-trae-connect`
(MIT) from the DeepSeek Harness plugin API to ZCode's.

- **Provider entries**: `trae` (国内版, root mount) and `trae-intl`
  (国际版, `/intl` mount) in `<dataBaseDir>\.zcode\v2\provider_config.json` —
  the data root comes from `dataBaseDir` in
  `%USERPROFILE%\.zcode\v2\setting.json` (default `%USERPROFILE%`), because
  ZCode resolves its data documents there, not under the profile root
- **Endpoint**: `http://127.0.0.1:39272/v1` (CN) and
  `http://127.0.0.1:39272/intl/v1` (国际版) — loopback only
- **State**: `%USERPROFILE%\.zcode-trae-connect\`
- **Roster**: pulled live from the upstream — CN bucket `solo_agent_remote`
  (16 usable models), intl bucket `solo_agent` (19, of which 8 are
  account-tier locked and keep a badge). Static fallback before the first
  fetch: auto / glm-5.3 / glm-5.2 / deepseek-v4.1-flash /
  DeepSeek-V4-Flash-Official / kimi-k3. Both mounts use the upstream ids
  verbatim.
- **Skill**: `trae-models` — how to operate and troubleshoot it

## Glossary

Terms that are easy to conflate in this project, and what each one means here.

**Edition** — which Trae backend a credential belongs to: `cn` for the
domestic app (`%APPDATA%\Trae CN`), `intl` for the international one
(`%APPDATA%\Trae`). Decided from the *installed app's* `product.json`
(`packageType`, region mirror tables), never from the directory name alone.
The two share model ids (`glm-5.3`, `kimi-k3`, …) with separate billing
accounts, so an edition is part of a request's identity.

**Mount** — the URL path segment that selects an edition on this endpoint:
the root for CN, `/intl` for international. This is the *only* channel a
client has for naming an edition, because ZCode sends no provider identifier
of any kind and never calls `/models` to learn a roster. Same decision as
`zcode-workbuddy-connect`'s region mounts; see
`docs/adr/0001-trae-remote-session-protocol.md`.

**Remote session** — one conversation turn on Trae's side: created with
`POST {remote}/chat_sessions`, read from
`GET {remote}/chat_sessions/{id}/events?reply_to_message_id=…` as SSE, and
deleted after the turn (即用即焚) so nothing bills against the account
afterwards.

**Snapshot frame** — one SSE event from `/events`. It re-sends the *entire
accumulated* `plan_item`, not a delta; only strictly-extending frames
(longer, same prefix) are new content. Treating them as deltas replays the
whole prefix per frame.

**tc envelope** — how the desktop apps store the sign-in in `storage.json`
under `iCubeAuthInfo://icube.cloudide`:
`[6B header][32B random][AES-128-CBC ciphertext]`, plaintext
`[64B SHA-512 hash][PKCS7-padded JSON]`, key/iv from
`SHA-512(SHA-512(random) || SALT_A^SALT_B)`. Decrypted locally with
`node:crypto`; the file is read-only input.

**Credential copy** — this service's own token store under the state
directory (`.trae-credentials.json` / `.trae-credentials-intl.json`). The
desktop app's sign-in file is *read-only* input; refreshes are written only
to the copy, so the plugin can never break the app's login.

**Endpoint bearer** — the secret ZCode presents to the loopback endpoint,
held in `endpoint.json` (mode 0600). Distinct from the Trae credential: it
never travels upstream, and it must be *stable* rather than per-process
because ZCode records it in its own config.

**Region mirror** — the international edition's remote gate is per account
region, taken from the installed program's `product.json` `remote.trae`
table. The compiled-in `core-normal.trae.ai` is the last resort, not the
source of truth. The credential record's own `host` is the AUTH domain,
never the remote gate.

## Start / stop

```sh
node bin/cli.mjs serve            # foreground
node bin/cli.mjs service-status   # is it up?
node bin/cli.mjs doctor           # full diagnosis
```

A `SessionStart` hook starts the endpoint automatically and verifies it came
up. If it could not, it says so with the command to run — it never claims
success on the strength of a spawn call alone.

## Why a local service

ZCode's plugin API cannot register an LLM provider, and DSH's can. Rather
than reimplementing the model plumbing against a capability that does not
exist, the upstream's OpenAI-compatible surface became a standalone service,
and ZCode's own third-party-model support points at it — the same shape as
`zcode-workbuddy-connect`, whose endpoint contract this service implements
(`fetchModels` / `fetchCredits` / `chatStream`).

## Files

| Path | Role |
|---|---|
| `.zcode-plugin/plugin.json` | manifest: skills + the `SessionStart` hook |
| `skills/trae-models/SKILL.md` | operating and troubleshooting skill |
| `hooks/service-ensure.mjs` | self-verifying endpoint starter |
| `src/upstream.js` | Trae wire client + the generator→stream adaptation |
| `src/credentials.js` | tc-envelope decryption, discovery, token refresh |
| `src/install.js` | installed-app detection (edition + region mirror) |
| `src/catalog.js` | model roster (+ static fallback) |
| `src/server.js` | the endpoint (ported from zcode-workbuddy-connect) |
| `src/loopback.js` | Host/Origin guards |
| `src/config.js` | runtime paths |
| `src/cli.js`, `bin/cli.mjs` | CLI |
| `tests/` | `node --test` suites: tc envelope roundtrip, flattenQuery, parseModelList dual shapes, the stream adapter |
| `docs/validate-provider-config.mjs` | strict-schema mirror; gates every `setup` write |
| `docs/verify-endpoint.mjs` | end-to-end check against a live endpoint |
| `docs/adr/0001-…` | the remote-session protocol, the snapshot diff, the eager first piece, edition by mount |

Upstream: <https://github.com/marsma-101/dsh-trae-connect>

## Boundaries

- **Never write to the Trae desktop app's own files.** The sign-in file is
  input only.
- **No tool calling** — the protocol has no such surface; do not add
  `tool_calls` handling that can never fire.
- **No credential ever reaches ZCode's config** other than the local
  endpoint's own bearer.
