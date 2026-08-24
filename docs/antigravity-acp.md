# Antigravity (Gemini) via ACP

> **Status: verified.** A real Gemini turn round-trips through ACP — handshake,
> session lifecycle, model catalogue, error propagation, and assistant text out.
> Re-check any time with `node payload/tests/antigravity-acp.turn.mjs`.
>
> One real limitation remains, and it is the CLI's, not the adapter's: replies
> arrive in a single chunk rather than streaming. See
> [Known limitation](#known-limitation-no-token-streaming).

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
  "description": "Google Antigravity (Gemini) via the agy CLI",
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

Two checks, both against the real CLI:

```bash
node payload/tests/antigravity-acp.handshake.mjs   # no quota needed
node payload/tests/antigravity-acp.turn.mjs        # sends a real prompt
```

| Check | Result |
|---|---|
| `initialize` negotiates a protocol version | pass |
| `loadSession` correctly declined | pass |
| `newSession` returns a session id | pass |
| Advertises models from `agy models` | pass — 14 models |
| Catalogue includes Gemini entries | pass |
| Accepts a model change | pass |
| Accepts `cancel` | pass |
| Provider errors propagate through ACP | pass — a quota error arrived intact |
| **A successful turn returns assistant text** | **pass** |

The turn test output that closed the last gap:

```
model   gemini-3.5-flash-low
prompt  "Reply with exactly: OK"
stop    end_turn
text    "OK"

TURN VERIFIED — assistant text round-tripped through ACP.
```

Live in Paseo, the provider reports `ready` with 14 Gemini models, so it is
selectable anywhere Fleet Supervisor offers a model.
