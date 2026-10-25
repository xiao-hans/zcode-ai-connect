# ADR 0001 — Trae remote-session protocol: what the endpoint adapts and why

Status: accepted (2026-10-17)

## Context

`marsma-101/dsh-trae-connect` (itself porting `autumnsentiment/Trae2api-cn`,
both MIT) drives Trae's internal **remote-session** API. It is not an
OpenAI-compatible surface, and every assumption an OpenAI client makes is
wrong for it:

1. **A turn is a remote session, not a request.** `POST /chat_sessions`
   creates a session; the reply is read from
   `GET /chat_sessions/{id}/events?reply_to_message_id=` as SSE. There is no
   `POST /chat/completions`.
2. **The event stream is a snapshot stream, not a delta stream.** Each SSE
   frame re-sends the *entire accumulated* `plan_item` so far. Consuming it
   as deltas would replay the whole prefix on every frame — quadratic output
   and garbage text. Only frames that strictly extend the previous one
   (longer, same prefix) are new content.
3. **There is no function calling.** The protocol carries plain text pieces
   (and a reasoning piece). `tools` in a request body is silently ignored
   upstream; the endpoint must not pretend otherwise.
4. **Sessions are stateful server-side.** A session left behind is billable
   clutter on the user's account, so each turn deletes its session after the
   stream ends (即用即焚, `--keep-session` to opt out).
5. **Two editions share model ids but not accounts.** The domestic edition
   (`%APPDATA%\Trae CN` → `trae-api-cn.mchost.guru`) and the international
   one (region-selected mirror from the install's `product.json`) expose the
   same ids (`glm-5.3`, `kimi-k3`, …) against separate credentials, so one
   client instance cannot serve both.

The port target — the WorkBuddy endpoint built for
`zcode-workbuddy-connect` — expects its upstream client to expose exactly
`{ ok, response: { body } }` where `body` is a Web `ReadableStream` of
OpenAI SSE bytes. Trae's `streamChat` is an async generator of pieces.

## Decision

Adapt at two narrow seams, and leave the protocol code itself untouched:

**Seam 1 — generator to ReadableStream** (`piecesToOpenAIStream`). The piece
generator is wrapped into a `ReadableStream<Uint8Array>` emitting OpenAI
chunks: `text` → `delta.content`, `reasoning` → `delta.reasoning_content`,
`usage` → a usage-only frame, `done` → a `finish_reason: "stop"` frame. The
terminator `[DONE]` is deliberately *not* written here — the endpoint's SSE
normalizer owns it, so heartbeat, non-streaming reassembly and termination
stay shared code paths. `onDone` (the 即用即焚 deletion) runs exactly once,
on normal end, error, or consumer cancel.

**Seam 2 — eager first piece.** `createSession` failures (locked model,
expired token, no credit) would otherwise surface *after* the SSE response
head is committed, where the only remaining move is to kill the socket.
`chatStream` therefore pulls the first piece eagerly — the first piece is
always the session broadcast, which only exists after `createSession`
succeeded — and returns `{ ok: false, ...classifyTraeError(error) }` on the
normal HTTP error path instead. The pulled piece rides along as `first` so
nothing is lost between the eager step and the stream.

**Edition by URL mount.** The two editions share one process and one port,
separated by mount: root for CN, `/intl` for international. This mirrors
`zcode-workbuddy-connect`'s region mounts (ADR 0003 there) and keeps the
model id a client displays clean — the ids are identical across editions,
and only the billing account differs. Each mount gets its own credential
store, catalog and client.

**Error classification** (`classifyTraeError`) maps the protocol's error
text onto HTTP statuses the endpoint already understands: token trouble →
401, throttling → 429, credit → 402, account-tier locks → 400, everything
else → 502.

## Consequences

**Gained.** The endpoint's server, SSE normalizer, non-streaming reassembly
and CLI are reused almost verbatim from the WorkBuddy port; the Trae-specific
code is the protocol client plus two small seams. Tool-call reassembly is
deleted rather than ported — the protocol has no such surface, and keeping
dead merge logic would only mislead.

**Lost.** No function calling, full stop. A ZCode agent asked to use tools
against a Trae model will see the model answer in prose instead. This is an
upstream limitation, not a port defect; the skill documents it.

**Cost of the snapshot stream.** Diffing accumulated frames is O(frame)
per event instead of O(1), and a session must be kept open for the whole
turn — which is what makes 即用即焚 a correctness concern (leaked sessions
bill against the user's account) rather than a nicety.

**Cost of the eager first piece.** One extra microtask of latency before the
response head, in exchange for every create-time failure being a clean HTTP
error instead of a severed stream.

## Alternatives rejected

- **Rewriting the protocol as deltas upstream.** It is not ours to change;
  the desktop app speaks the snapshot protocol and so must the port.
- **Keeping sessions for reuse.** Sessions are per-turn scratch space on
  someone else's account; the upstream gives no listing API to reclaim
  leaked ones, so deletion at end-of-turn is the only safe default.
- **One client for both editions, edition chosen per request.** The two
  editions bill separate accounts and resolve separate upstream hosts; a
  single client would have to re-derive the credential mid-request. The
  mount keeps the choice where it belongs: in the URL the client dialed.
