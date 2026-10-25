---
name: trae-models
description: Operate the Trae model provider — start/stop the local endpoint, check sign-in and remaining credit, list or refresh the model roster, and troubleshoot "model fails to respond" errors. Use when the user asks about Trae models in ZCode, the provider shows no models, a Trae model errors out, credit balance, or the login state of the Trae desktop app.
when_to_use: The user mentions Trae, the Trae provider, a Trae model (GLM-5.3, DeepSeek-V4.1-Flash, Kimi-K3, Trae Auto), or reports that a model from this provider fails.
---

# Trae models in ZCode

This plugin exposes the models inside the **Trae desktop app** (domestic and
international editions) as ZCode model providers. Trae's models are reachable
only with the app's own login, and only through an internal remote-session
API that rejects ordinary OpenAI clients, so a small local service translates
between the two:

```
ZCode ──(OpenAI chat-completions)──▶ 127.0.0.1:39272 ──▶ trae-api-cn.mchost.guru
                                       local endpoint      (Trae remote sessions)
```

The service reads the Trae desktop app's sign-in (read-only, tc-encrypted
`storage.json`), refreshes tokens into its own state directory, and runs the
model roster as a provider. Everything lives outside the app: nothing here
writes to Trae's files.

## Where things are

| Thing | Path |
|---|---|
| Service + CLI | `${ZCODE_PLUGIN_ROOT}` |
| State (token copy, endpoint bearer, logs) | `%USERPROFILE%\.zcode-trae-connect` |
| Provider entry (registry the picker reads) | `<dataBaseDir>\.zcode\v2\provider_config.json` — resolved from `dataBaseDir` in `%USERPROFILE%\.zcode\v2\setting.json`, defaulting to `%USERPROFILE%` |
| Provider entry (mirror) | `<dataBaseDir>\.zcode\v2\config.json` → `provider` object |
| Trae CN sign-in (read-only) | `%APPDATA%\Trae CN\User\globalStorage\storage.json` |
| Trae international sign-in (read-only) | `%APPDATA%\Trae\User\globalStorage\storage.json` |

All CLI commands below are run as `node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" <command>`.

## The one thing that usually matters

The provider only works while the local endpoint is running. A `SessionStart`
hook starts it automatically, but a locked-down host can refuse a detached
spawn, so the first check for any "model not responding" report is always:

```sh
node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" service-status
```

- **`endpoint … up (N models)`** — the service is fine; look elsewhere.
- **`endpoint … NOT reachable`** — start it in a terminal:
  `node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" serve`

## Commands

| Command | What it does |
|---|---|
| `serve` | Run the endpoint in the foreground (`--port` to change, default 39272) |
| `service-status` | Is the endpoint reachable; is autostart registered |
| `status` | Sign-in state, token expiry, remaining credit, the whole model roster |
| `refresh` | Re-pull the model roster from the upstream |
| `doctor` | Credentials, install detection, upstream reachability, catalog, credits |
| `setup` | Rewrite the ZCode provider entries from the live roster |
| `install-service` / `uninstall-service` | Register/remove a logon autostart launcher |
| `logout` | Drop the plugin-owned credential copy (the desktop app is untouched) |

## Two editions, two mounts

| Edition | Provider | Base URL | Desktop data dir |
|---|---|---|---|
| 国内版 (CN) | `trae` | `http://127.0.0.1:39272/v1` | `%APPDATA%\Trae CN` |
| 国际版 (international) | `trae-intl` | `http://127.0.0.1:39272/intl/v1` | `%APPDATA%\Trae` |

Both editions share model ids (`glm-5.3`, `kimi-k3`, …) but bill against
separate accounts, so they are told apart by the URL mount, never by renaming
models. An edition whose app is not signed in is skipped at `setup` and
exposes no models. The international upstream is resolved from the installed
app's own `product.json` (region-selected mirror); `--intl-remote-base` /
`TRAE_INTL_REMOTE_BASE` overrides it.

## Diagnosing a failure

Work through these in order; each one is cheap and they are ordered by how
often they are the cause.

1. **Is the endpoint up?** `service-status`. If not reachable, start it.
2. **`401 missing or invalid Authorization bearer` — the API key field holds
   something other than the bearer.** This is the classic trap: `/v1/models`
   is deliberately exempt from the bearer (so a client can discover the
   roster), which makes ZCode's "fetch models" step succeed and *look*
   configured — but chat requires the bearer, so the first message 401s.
   Two observed shapes of "something else":
   - **Empty field** — the user skipped the key entirely.
   - **The clipboard command pasted verbatim** — `token | clip` prints the
     bearer for copying, but the whole command line (`node "…\bin\cli.mjs"
     token | clip`) can land in the field instead of its output. It looks
     filled in, which is what makes it nasty.
   Fix: edit the provider in ZCode's UI and paste the bearer itself (copy it
   with `node bin/cli.mjs token | clip`, then paste into the key field — the
   *output*, not the command). The endpoint logs every 401 with the
   auth-header shape (`auth=absent` = empty; `auth=Bearer node "D:\…` = the
   command was pasted; `auth=Bearer w55jld…(43 chars)` = correct shape but
   wrong/rotated value), so one retry tells the cases apart.
3. **A file-written provider never appears in the picker?** ZCode resolves
   its data documents under `dataBaseDir` (from
   `%USERPROFILE%\.zcode\v2\setting.json`, default `%USERPROFILE%`), NOT under
   the profile root: the picker reads
   `<dataBaseDir>\.zcode\v2\provider_config.json`. A document written to
   `%USERPROFILE%\.zcode\v2\provider_config.json` validates perfectly and is
   read by nothing. `setup` resolves the root itself; if entries were written
   by hand or by an older run, re-run `setup` (it merges, never clobbers) or
   pass `--config <path>` explicitly.
4. **Is Trae still signed in?** `doctor`. The desktop app's token expires;
   when it does, the fix is to open the Trae app once — and keep it running,
   because the scan reads its live `storage.json`. The plugin cannot sign in
   on the user's behalf and must never be asked to.
5. **Does the model still exist?** `refresh` then `status`. The upstream
   roster changes often — models appear and disappear — so a model that
   worked last month may simply be gone. International-edition models can
   also be **locked to the account tier**; a locked model keeps its badge in
   `status` but the upstream refuses it with a 400. Model ids are matched
   case-insensitively upstream, so `GLM-5.3-Flash` and `glm-5.3-flash` are
   the same model.
6. **Is there credit left?** `status` prints the remaining credit. `402` from
   the endpoint means insufficient credit, and no local fix exists.
7. **Read the log.** `%USERPROFILE%\.zcode-trae-connect\service.log` records
   hook and startup decisions; the running service also prints to its console.

## Boundaries — do not cross these

- **Never write to the Trae desktop app's own files.** The sign-in file is
  read-only input. Token refreshes go to
  `%USERPROFILE%\.zcode-trae-connect\.trae-credentials.json` (and
  `.trae-credentials-intl.json` for the international edition) and nowhere
  else; that separation is what stops this plugin from breaking the desktop
  app's login.
- **Never ask for or handle the user's Trae password.** The plugin reuses
  the desktop app's existing session by design; there is no credential to
  type.
- **Do not hand-edit the token** in `endpoint.json` while the service is
  running — the service holds the bearer in memory from startup, so a
  hand-edited value will not match and every request will 401. Change it with
  `--token` and restart, or delete `endpoint.json` and let it regenerate.
- **Do not "fix" a missing model by adding it to the provider config by
  hand.** Run `setup`: it writes the roster the upstream actually reports.

## Notes on behaviour worth knowing

- **No tool calling.** The Trae remote-session protocol is a plain-text
  channel — it has no function-calling surface, so the endpoint never emits
  `tool_calls`. An agent asked to use tools against a Trae model will get
  prose instead. This is an upstream limitation.
- **Sessions are burned after each turn.** Each turn creates a remote
  session and deletes it when the stream ends (即用即焚), so nothing bills
  against the account after the reply. `--keep-session` opts out for
  debugging.
- **Reasoning models think for a long time before their first token.** The
  endpoint emits SSE heartbeat comments during that silence so the
  connection survives it. A long pause before the first word is normal, not
  a hang.
- **Context windows are taken at their maximum** (1M max-mode where the
  model declares it), because the softer default window makes ZCode compact
  the conversation early. `--default-context-window` reverts to the softer
  number.
- **Prices are informational.** Rates come from the upstream roster and are
  cached; the setup labels show the credit multiplier per model (`· 免费`,
  `· x0.8`).
