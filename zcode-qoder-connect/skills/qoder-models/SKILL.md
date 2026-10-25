---
name: qoder-models
description: Operate the Qoder model provider — start/stop the local endpoint, check credential and quota, list or refresh the model roster, run daily check-in, and troubleshoot "model fails to respond" errors. Use when the user asks about Qoder models in ZCode, the provider shows no models, a Qoder model errors out, quota balance, or the check-in credits.
when_to_use: The user mentions Qoder, the Qoder provider, or a Qoder model (DeepSeek-V4-Pro, DeepSeek-Flash, Qwen3.8-Max, Qwen3.8-Flash, GLM-5.3, Fast, Auto), or reports that a model from this provider fails.
---

# Qoder models in ZCode

This plugin exposes the models inside the **Qoder CN desktop app** as a ZCode
model provider. Credentials are reused read-only from the Qoder desktop's own
sign-in vault (DPAPI + AES-GCM `auth.v1.dat`); a PAT
(`qoder.cn → 账号设置 → 个人访问令牌`) is an optional fallback. A small local
service translates between OpenAI chat-completions and Qoder's COSY-signed
gateway protocol:

```
ZCode ──(OpenAI chat-completions)──▶ 127.0.0.1:39270 ──▶ gateway.qoder.com.cn
                                       local endpoint      (COSY + WAF encode)
```

## Where things are

| Thing | Path |
|---|---|
| Service + CLI | `${ZCODE_PLUGIN_ROOT}` |
| State (PAT, endpoint bearer, logs) | `%USERPROFILE%\.zcode-qoder-connect` |
| Provider entry (registry the picker reads) | `%USERPROFILE%\.zcode\v2\provider_config.json` |
| Qoder desktop vault (read-only) | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat` |

All CLI commands are run as `node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" <command>`.

## The one thing that usually matters

The provider only works while the local endpoint is running. A `SessionStart`
hook starts it automatically, but if a session reports "model not responding":

```sh
node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" service-status
```

- **`endpoint … up`** — the service is fine; look elsewhere (quota, credential).
- **`endpoint … NOT reachable`** — start it:
  `node "${ZCODE_PLUGIN_ROOT}/bin/cli.mjs" serve --port 39270`

## Commands

| Command | What it does |
|---|---|
| `serve [--port N]` | Run the endpoint (default 39270) |
| `status` | Credential tracks (desktop vault / PAT), quota, model roster |
| `refresh` | Re-pull the model roster from the gateway |
| `checkin` | Claim today's Qoder check-in credits when a campaign is live |
| `login <PAT>` | Validate and save a personal access token |
| `logout` | Drop the saved PAT (desktop vault untouched) |
| `service-status` | Is the endpoint reachable |

## Diagnosing a failure

1. **Is the endpoint up?** `service-status`. If not reachable, start it.
2. **Is the desktop dt- token fresh?** `status`. When it reads `dt- 已过期`,
   the fix is opening the Qoder CN desktop app ONCE so it refreshes the vault
   (the plugin re-reads it automatically; no re-login needed on this side).
3. **Quota left?** `status` prints the credits document
   (`isQuotaExceeded`, `totalUsagePercentage`).
4. **Free-tier models queue at peak** — the service retries a queued request
   (code 10605) for ~24s; a 429-ish failure right after usually means the queue
   was longer still. Retry, or switch to a paid-tier model.
5. **Model roster changed?** `refresh` then `status`.
