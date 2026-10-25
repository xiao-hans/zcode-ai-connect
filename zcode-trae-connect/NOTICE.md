# Attribution

This project is a port of **[marsma-101/dsh-trae-connect](https://github.com/marsma-101/dsh-trae-connect)**
(MIT) from the DeepSeek Harness plugin API to ZCode's, following the same
porting pattern as `zcode-workbuddy-connect`.

The upstream project in turn implements the Trae remote-session protocol
documented by the MIT-licensed **[autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn)**
project (credential decryption, session/event streaming, token exchange).

## What came from where

**Brought over from the upstream (behaviour preserved deliberately, because it
is what makes the endpoint work at all):**

- The `tc` credential-envelope decryption (static salts, SHA-512 key schedule,
  AES-128-CBC, PKCS7 + hash verification) and the desktop data-directory
  discovery (per-platform bases, known names, loose "name contains trae" scan,
  explicit-path overrides)
- Edition resolution: the installed app's `product.json` host tables decide
  which edition owns a credential, with the host/region/dir-name heuristic as
  the fallback
- The remote-session protocol: `createSession` body shape (including the
  max-mode context-window fields and `custom_model` resolution), the SSE event
  reader, the cumulative `plan_item` snapshot diffing, token-usage events,
  `ExchangeToken` renewal
- The model-catalog fetch (per-edition function bucket, dual payload shapes),
  the fallback roster, lock detection from `features.access.enable`, effort
  discovery from `features.reasoning.enable`, rate display, and the
  即用即焚 session deletion
- The loopback endpoint and its inbound hardening (loopback Host, loopback
  Origin, JSON content type, constant-time bearer check, public model
  discovery)

**Rewritten for this port:**

- The DSH plugin API surface (adapter, settings card, web status routes) is
  gone: ZCode consumes a plain OpenAI-compatible provider, so the shim became
  a standalone service (`serve`) plus a `setup` command that writes the
  ZCode provider entries — the personal provider registry
  (`provider_config.json`, what the model picker reads) and the mirror
  `provider` object in `config.json`, both resolved under ZCode's
  `dataBaseDir` data root
- The async-generator stream is wrapped into a Web `ReadableStream` of OpenAI
  SSE chunks (`TraeUpstreamClient.chatStream`), so the endpoint's existing
  SSE normalizer, heartbeat, non-streaming reassembly and error mapping apply
  unchanged
- The endpoint bearer is persisted (the client records it in its config file
  and it must survive restarts), and `/v1/models` + `/healthz` are exempt from
  the bearer so ZCode's provider-adding probe can read the roster
- The editions are URL mounts (`/v1` for 国内版, `/intl/v1` for 国际版) instead
  of model-id prefixes, mirroring `zcode-workbuddy-connect`
- The credential copy lives in `~/.zcode-trae-connect` instead of the DSH home

## Licence

MIT throughout. See [LICENSE](./LICENSE).
