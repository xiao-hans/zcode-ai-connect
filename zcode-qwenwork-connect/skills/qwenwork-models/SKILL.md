---
name: qwenwork-models
description: Operate the QwenWork (千问办公) model provider — start/stop the local endpoint, check sign-in and quota, and troubleshoot "model fails to respond" errors. Use when the user asks about QwenWork models in ZCode, the provider shows no models, a QwenWork model errors out, or quota balance questions.
when_to_use: The user mentions QwenWork, 千问办公, the QwenWork provider, or a QwenWork model (Qwen3.8-Flash, Pro, Qwen3.8-Max), or reports that a model from this provider fails.
---

# QwenWork models in ZCode

This plugin exposes the models inside the **千问办公 (QwenWorkCN) desktop app**
as a ZCode model provider. Credentials are reused read-only from the desktop
app's own sign-in (DPAPI + AES-GCM `auth-v2.dat`); requests are signed with the
same-source WASM signer the app itself uses. A small local service translates
between OpenAI chat-completions and the signed gateway protocol:

```
ZCode ──(OpenAI chat-completions)──▶ 127.0.0.1:39269 ──▶ gateway.qwenwork.cn
                                       local endpoint     (COSY WASM signer)
```

## Where things are

| Thing | Path |
|---|---|
| Service + CLI | `${ZCODE_PLUGIN_ROOT}` |
| State (endpoint bearer, logs) | `%USERPROFILE%\.zcode-qwenwork-connect` |
| QwenWork desktop sign-in (read-only) | `%APPDATA%\QwenWorkCN\auth-v2.dat` |

All CLI commands are run as `node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" <command>`.

## The one thing that usually matters

The provider only works while the local endpoint is running. A `SessionStart`
hook starts it automatically, but if a session reports "model not responding":

```sh
node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" service-status
```

- **`endpoint … up`** — the service is fine; look elsewhere (quota, sign-in).
- **`endpoint … NOT reachable`** — start it:
  `node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" serve --port 39269`

## Commands

| Command | What it does |
|---|---|
| `serve [--port N]` | Run the endpoint (default 39269) |
| `status` | Sign-in state, quota, model roster with rates |
| `doctor` | Credential, gateway endpoint, WASM signer diagnostics |
| `service-status` | Is the endpoint reachable |

## Models and billing

The roster is static (taken from the desktop app's own catalog) — there is no
`refresh` because the upstream catalog is not fetched dynamically:

| id | tier | rate |
|---|---|---|
| `pro` | 高级（默认档） | ×1.00 |
| `qwen3.8-flash` | 标准 | ×0.10 |
| `qwen3.8-max-preview` | Qwen3.8-Max | ×1.10 |

All models: 1M context, 32K output, vision input, reasoning (`reasoning_content`
is streamed as thinking). `flash` is the cheap everyday pick; every call bills
against the QwenWork account's quota at the listed rate.

## Diagnosing a failure

1. **Is the endpoint up?** `service-status`. If not reachable, start it.
2. **Is the desktop app signed in?** `doctor`. When the sign-in is missing or
   the token cannot refresh, the fix is opening the 千问办公 desktop app ONCE —
   the plugin re-reads its vault automatically; there is no separate login here.
3. **Quota left?** `status` prints the account quota document.
4. **First token slow at peak?** The upstream queues long-thinking requests;
   the shim gives it 90s to produce the first frame and 300s of stream silence
   before giving up with an explicit error. A timeout usually means upstream
   congestion — retry, or switch to `qwen3.8-flash`.
5. **Empty answers / truncation** are reported as errors, not as silent empty
   turns — the shim re-labels cut streams so the client retries instead of
   hanging.
