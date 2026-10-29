# zcode-trae-connect

Use the models inside the **Trae desktop app** from ZCode (or any
OpenAI-compatible client), with zero configuration.

A port of [marsma-101/dsh-trae-connect](https://github.com/marsma-101/dsh-trae-connect)
(MIT, itself a port of [autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn))
from the DeepSeek Harness plugin API to ZCode's, keeping the original's
wire behaviour and discarding the parts that have no ZCode equivalent.

```
ZCode ──(OpenAI chat-completions)──▶ 127.0.0.1:39272 ──▶ trae-api-cn.mchost.guru
                                       local endpoint      (Trae remote sessions)
```

## Why this shape

The upstream plugin registered models into DSH's own provider registry and
drew a settings card in DSH's UI. ZCode has **no "register an LLM provider"
plugin slot**, so a literal port is impossible. What ZCode *does* have is
native support for third-party models configured as
`api.type: "openai-chat-completions"` with a `baseUrl` and API key — and the
WorkBuddy port of this family already proved the shape: a standalone loopback
OpenAI-compatible service, pointed at by a ZCode provider entry.

The Trae protocol forced two adaptations beyond that shape, because it is
not an HTTP request/response API at all:

- A turn is a **remote session** (`POST /chat_sessions` + an SSE snapshot
  stream on `/events`), not a chat completion.
- The SSE stream re-sends the **whole accumulated reply** on every frame, so
  the endpoint diffs frames instead of appending them. See
  `docs/adr/0001-trae-remote-session-protocol.md`.

The discarded parts are the ones with no ZCode surface: the settings card and
the Composer probe control.

## Layout

```
.zcode-plugin/plugin.json      plugin manifest (skills + SessionStart hook)
skills/trae-models/            operational skill for the agent
hooks/service-ensure.mjs       starts the endpoint at session start
src/                           the service (no dependencies; Node >= 18)
  upstream.js                  Trae wire client: sessions, catalog, credits
  credentials.js               tc-envelope decryption, discovery, token refresh
  install.js                   installed-app detection (edition + region mirror)
  catalog.js                   model roster + static fallback
  server.js                    the loopback OpenAI-compatible endpoint
  loopback.js                  Host/Origin guards
  config.js                    runtime paths
  cli.js                       command-line interface
bin/cli.mjs                    entry point
```

## Commands

```sh
node bin/cli.mjs serve              # run the endpoint (foreground)
node bin/cli.mjs status             # sign-in, credit, model roster
node bin/cli.mjs doctor             # diagnose credentials/install/upstream/credits
node bin/cli.mjs refresh            # re-pull the roster
node bin/cli.mjs setup              # (re)write the ZCode provider entries
node bin/cli.mjs service-status     # is it reachable; is autostart registered
node bin/cli.mjs install-service    # register a logon autostart launcher
node bin/cli.mjs uninstall-service  # remove it
node bin/cli.mjs logout             # drop our credential copy (desktop app untouched)
node bin/cli.mjs token              # print the endpoint bearer
```

## Install

1. Put this directory anywhere and add its **path** to ZCode's
   `plugins.dirs` in `%USERPROFILE%\.zcode\cli\config.json`:

   ```json
   { "plugins": { "dirs": ["<absolute-path-to-this-repo>"] } }
   ```

   Plugins found this way get the marketplace id `inline` and are enabled by
   default. The listed directory **is** the plugin root — do not nest it.

2. Start the Trae desktop app and sign in (both editions if you have both),
   then write the provider entries:

   ```sh
   node bin/cli.mjs setup
   ```

   `setup` refuses to guess: it writes the roster the upstream actually
   reports, and it **validates before writing** — the document is serialised
   to a temp file and run through `docs/validate-provider-config.mjs`, and is
   only renamed into place if it passes. See the strict-schema note below for
   why that gate is not optional. The write target is ZCode's **data root**:
   `<dataBaseDir>\.zcode\v2\provider_config.json`, where `dataBaseDir` comes
   from `%USERPROFILE%\.zcode\v2\setting.json` (default `%USERPROFILE%`) —
   ZCode resolves its data documents there, not under the profile root, and a
   document written to the wrong root is read by nothing.

3. The models appear in the model selector under **Trae 国内版** (CN) and
   **Trae 国际版** (international). A running ZCode picks the registry change
   up on its next config poll; restart it if the entries do not show. The
   `SessionStart` hook starts the endpoint.

### Credentials

The Trae desktop apps keep their sign-in in
`%APPDATA%\<data dir>\User\globalStorage\storage.json` under the
`iCubeAuthInfo://icube.cloudide` key, sealed with the app's own "tc"
envelope:

```
[6B header][32B random][AES-128-CBC ciphertext]
plaintext = [64B SHA-512 hash][PKCS7-padded JSON]
key/iv    = SHA-512(SHA-512(random) || SALT_A^SALT_B)[0..16]/[16..32]
```

The salts are static constants baked into the app's frontend; the decryption
is local (`node:crypto` only) and the sign-in file is **read-only input** —
refreshes go to the plugin's own state directory, never back to the app.

Which edition a credential belongs to is decided by the **installed app**,
not the directory name: `install.js` reads each install root's
`product.json` (`packageType`, region mirror tables). The domestic edition
lives in `%APPDATA%\Trae CN`; the international one in `%APPDATA%\Trae`
(TRAE SOLO adds `TRAE SOLO CN` / `TRAE SOLO`). Explicit paths always win:
`--data-dir-cn` / `--data-dir-intl`, or `TRAE_DATA_DIR_CN` /
`TRAE_DATA_DIR_INTL`.

### Two editions, two mounts

| Edition | Provider | Base URL | Upstream |
|---|---|---|---|
| 国内版 (CN) | `trae` | `http://127.0.0.1:39272/v1` | `https://trae-api-cn.mchost.guru/api/remote/v1` |
| 国际版 | `trae-intl` | `http://127.0.0.1:39272/intl/v1` | region mirror from the install's `product.json` |

Both editions share model ids (`glm-5.3`, `kimi-k3`, …) but bill against
separate accounts, so they are told apart by the URL mount, never by renaming
models — the same decision `zcode-workbuddy-connect` made for its regions.
An edition whose app is not signed in is skipped at `setup` and exposes no
models. The international remote gate is region-dependent and resolved from
the installed program; `--intl-remote-base` / `TRAE_INTL_REMOTE_BASE`
overrides it when the app is not installed.

### Limits written into ZCode

`setup` declares, per model, the context window at its **maximum** — the 1M
max-mode profile where the model declares one, because the softer default
window makes ZCode compact the conversation early and waste the window. The
credit multiplier is shown in the setup labels (`· 免费`, `· x0.8`) and
locked international-edition models keep a badge instead of being filtered
out, so the picker mirrors the real tier view.

### The strict-schema trap

ZCode parses `provider_config.json` with zod schemas that are `.strict()`,
and its failure mode is brutal: **one unrecognised key anywhere makes ZCode
discard the entire personal provider config** and fall back to an empty one —
taking every other provider you had configured with it, and surfacing no
error. After any hand-edit, check it yourself:

```sh
node docs/validate-provider-config.mjs
```

## Design decisions

| Decision | Why |
|---|---|
| Standalone loopback service, not an MCP server | An MCP tool cannot drive ZCode's agent loop; a provider can. Native streaming comes for free. |
| Zero runtime dependencies | Node 18+ has `fetch`, `AbortSignal.timeout` and `http`. Fewer moving parts to break, and no install step. |
| Dual edition, one service | CN and international share one endpoint, separated by URL mount. The shared model ids stay clean, and the edition never has to be encoded into the id a client displays. |
| Fixed port + persisted bearer | The client records the bearer in its own config, so it must survive restarts. A per-process secret would break on every restart. |
| Credential copy kept separate from the desktop app | The app's sign-in file is read-only input. Refreshes go to our own state dir, so the plugin can never break the app's login. |
| 即用即焚 sessions | A remote session left behind is billable clutter on the user's account, and the upstream offers no way to list or reclaim leaked ones. Deleting at end-of-turn is the only safe default (`--keep-session` opts out). |
| Eager first piece | `createSession` failures (locked model, expired token, no credit) must surface as clean HTTP errors, not as deaths after the SSE head is committed. |
| Snapshot-stream diffing | The upstream re-sends the whole accumulated reply per frame; only strictly-extending frames are new content. See the ADR. |
| Validate before writing provider config | A stray key does not fail one model, it silently deletes every provider. A temp file plus a schema mirror turns that into a loud error. |

## Stream lifecycle (why a turn never "just stops")

A long turn is where every proxy flaw shows up as the same symptom: the model
goes quiet, the spinner keeps turning, nothing errors. Five rules keep that
from happening, and they are the reason to prefer this endpoint over a plain
passthrough:

| Situation | What the endpoint does |
|---|---|
| Upstream sends nothing for 180 s on an already-open stream | Writes an `error` frame with `type: "upstream_stalled"`, finishes with `finish_reason: "network_error"`, closes with `[DONE]`, and aborts the upstream call. The client retries; it never hangs behind our heartbeat. |
| Upstream closes the stream without a finish frame | Finishes with `finish_reason: "length"` — a cut answer is reported as cut. It is **never** rewritten to `stop`, which is what made truncated answers look like "the model decided it was done". |
| The turn streamed tool calls but the upstream labelled it `stop` | The finish reason is corrected to `tool_calls`, because clients gate their agent loop on it. |
| The turn produced nothing at all (thinking only) | An `error` frame (`type: "empty_answer"`) is emitted so the client retries instead of accepting an empty assistant message. |
| The client disconnects mid-stream | The upstream request is aborted and the remote session deleted, so a cancelled turn costs nothing and cannot occupy the account's concurrency budget (Trae allows 2 sessions). |

The watchdog interval is configurable: `ZC_STREAM_IDLE_TIMEOUT_MS` (default
`180000`). Heartbeats (`: heartbeat` every 10 s) are still emitted — they keep
the *client's* read timer alive — but they deliberately do **not** reset the
watchdog, which only listens to real upstream bytes.

Behaviour is covered by `tests/test-stream-guard.mjs`.

## Stop hook: continue a turn that only announced the next step

A second hook ships beside `SessionStart`. When a turn is about to end with
**zero tool calls**, `hooks/stall-guard.mjs` scores the tail of the reply
(`hooks/stall-detector.mjs`). A reply that announces work without doing it —
`我先…`, `接下来…`, `Let me…`, usually ending in a colon — makes the hook print

```json
{"decision":"block","reason":"<continue prompt>"}
```

and ZCode feeds that prompt back for one more model request (contract read from
`zcode.cjs`'s `processHookOutput`).

Guards, because a wrong nudge is worse than a missed one:

- a question, a request for your decision, or a completion summary is never continued;
- the same reply text is continued at most once — the four `zcode-*-connect`
  plugins claim an atomic fingerprint lock (`~/.zcode-stall-guard/`, override
  with `ZCODE_STALL_GUARD_HOME`) so one prompt is injected, not four;
- an explicit `exit 2` is never used: for `Stop` it means "continue", and the
  error text would be replayed to the model as an instruction.

The hook applies to **every** model in ZCode, not only this provider — the
`Stop` payload carries no provider. The detector is a verbatim copy of
`shared/stall-detector.mjs` in the suite root; regression test:
`node tests/test-stall-detector.mjs`.

## Notes

- **No tool calling.** The Trae remote-session protocol is a plain-text
  channel; the endpoint never emits `tool_calls`. An agent asked to use tools
  against a Trae model will get prose instead. This is an upstream
  limitation.
- **No credential ever reaches ZCode's config** other than the local
  endpoint's own bearer. The Trae token stays in the state directory, in
  memory, or on the wire to Trae.
- State lives in `%USERPROFILE%\.zcode-trae-connect\`
  (`ZCODE_TRAE_CONNECT_HOME` overrides it).

## A note on what this talks to

The endpoint forwards to Trae's own internal API, using the Trae desktop
app's existing login. That API is **undocumented and unofficial** — it is not
a public integration surface, and it can change or break without notice.
This project therefore:

- makes **no stability promise** on the wire format, and
- inherits any terms the Trae service imposes on its own client.

It reads only the app's own sign-in file, never writes to it, and reuses the
session the user already established — there is no bypass, no credential
harvesting, and no traffic to any host the desktop app does not already talk
to. Use it with your own account. This is a port of a project that already
does the same thing publicly; the caveats above are the original's,
restated because they matter more than the feature list.

**Never committed:** the credential copy, the endpoint bearer, and all
runtime state. See `.gitignore` — state lives in
`%USERPROFILE%\.zcode-trae-connect\`, and `endpoint.json` there holds a
bearer that would let a reader call *your* endpoint.

## Licence

MIT, following the original. See [NOTICE.md](./NOTICE.md) for exactly which
parts were carried over from the upstream and which were rewritten for this
port.
