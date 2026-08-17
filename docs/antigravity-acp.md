# Antigravity (Gemini) via ACP — **experimental**

> **Status: the happy path has never been executed.**
> The handshake, session lifecycle and model catalogue are verified against the
> real `agy` CLI. A successful Gemini turn is **not** — the account used during
> development was out of quota. Read [Verification status](#verification-status)
> before relying on this.

## Why an adapter is needed

Paseo drives external agents over the **Agent Client Protocol** (ACP): it spawns
a process and speaks JSON-RPC to it over stdio. That is why Cursor works — the
`cursor-agent` binary has an `acp` subcommand:

```json
"fleet-cursor": {
  "extends": "acp",
  "command": ["agent", "--yolo", "--trust", "--approve-mcps", "acp"]
}
```

Antigravity's CLI has no such mode. Its full subcommand list is:

```
agent  agents  changelog  help  install  models  plugin  plugins  update
```

There is no `acp`, and no server mode. So Paseo cannot address `agy` at all.
This is why an `antigravity` entry in Fleet Supervisor's fallback order was
silently dead, and why its card offered no model list: nothing was ever
connected behind it.

`agy models` listing Gemini models does not help on its own — Paseo needs a way
to *run a turn*, not just enumerate models.

## What the adapter does

`payload/src/antigravity-acp.mjs` is the missing half. It speaks ACP to Paseo on
stdio using the same `@agentclientprotocol/sdk` that Paseo uses on the client
side, and drives `agy --print --output-format stream-json` underneath.

It implements the five required `Agent` methods — `initialize`, `newSession`,
`authenticate`, `prompt`, `cancel` — plus `unstable_setSessionModel` so the
model can be changed from Paseo.

### Model catalogue

`agy models` output is parsed and advertised through
`NewSessionResponse.models.availableModels`. Paseo maps that into its own model
list, which is what makes a real Gemini picker appear in Fleet Supervisor's
fallback and reviewer cards.

### Conversation continuity

The `conversation_id` from `agy`'s `init` event is captured and replayed as
`--conversation <id>` on later prompts, so multi-turn context survives.

## Known limitation: no token streaming

`agy`'s stream-json emits three event kinds:

```json
{"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…"}}
{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"agent_response"}}
{"event":"result","result":{"status":"…","response":"…","error":"…","usage":{…}}}
```

**`step_update` carries no text** — only `step_index`, `state` and `step_type`.
The assistant's words arrive once, at the end, in `result.response`.

So the adapter emits a single `agent_message_chunk` when the turn completes.
Replies appear all at once rather than streaming in. That is a property of the
CLI, not a shortcut taken here. If `agy` later emits incremental text events,
the `#onEvent` switch in the adapter is the place to handle them.

## Configuration

Registered in `~/.paseo/config.json`:

```json
"antigravity": {
  "extends": "acp",
  "label": "Antigravity",
  "description": "Google Antigravity (Gemini) via the agy CLI — EXPERIMENTAL",
  "command": ["<absolute path to node>", "<repo>/payload/src/antigravity-acp.mjs", "--skip-permissions"],
  "env": {}
}
```

`--skip-permissions` passes `--dangerously-skip-permissions` to `agy`. It
mirrors how `fleet-cursor` runs Cursor with `--yolo`: this provider exists for
unattended handoffs, where an interactive permission prompt would hang the turn.
Drop the flag if you want `agy` to enforce its own prompts — but expect turns to
stall when it asks for something.

`AGY_BIN` overrides the binary; `AGY_ACP_SKIP_PERMISSIONS=1` is equivalent to
the flag.

## Verification status

Run the handshake check:

```bash
node payload/tests/antigravity-acp.handshake.mjs
```

**Verified against the real CLI:**

| Check | Result |
|---|---|
| `initialize` negotiates a protocol version | pass |
| `loadSession` correctly declined | pass |
| `newSession` returns a session id | pass |
| Advertises models from `agy models` | pass — 14 models |
| Advertises a current model | pass — `gemini-3.7-flash-high` |
| Catalogue includes Gemini entries | pass |
| Accepts a model change | pass |
| Accepts `cancel` | pass |

Also verified: the `init` / `step_update` / `result` event shapes, observed from
a real `agy --print --output-format stream-json` run.

**NOT verified:**

- A successful turn producing assistant text. `result.response` is populated
  from the observed schema, but has only ever been seen as `""` on the error
  path, because the development account hit `Individual quota reached`.
- Whether a *successful* run emits richer incremental events than the
  quota-failed run did.
- Fleet Supervisor handing off to this provider end to end.

To finish verification once quota is available:

```bash
agy --print "Reply with exactly: OK" --output-format stream-json --model gemini-3.5-flash-low
```

If that returns `"status":"OK"` with text in `result.response`, send a prompt to
an Antigravity agent in Paseo and confirm the reply renders. Until someone has
watched that happen, treat this adapter as unproven.
