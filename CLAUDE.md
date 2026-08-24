# CLAUDE.md — Fleet Supervisor / Fleet Guard

Working notes for agents on this repo. Everything here was paid for in debugging
time; read it before touching Paseo integration.

## The one rule

**Verify against the binary the user actually runs.** Three separate failures on
this project came from verifying somewhere convenient instead. If you cannot
verify something, say so — in the report, the commit message, the README, and the
code. Do not imply it works.

The three, because the pattern repeats:

1. A handoff verified against Paseo built from `main` in a Linux container. The
   user's installed 0.4.0 had no plugin system, so none of it worked.
2. A fabricated `.d.ts` export (`PluginActionPayloadSchema`) that typechecked,
   built, and died at runtime as an opaque 30s RPC timeout.
3. A packaged build that worked only because it sat *inside* the repo and
   resolved `react` from the workspace root. Installing it elsewhere broke every
   plugin.

Prefer a cheap empirical probe over reasoning from source. A 400 response in
177 ms once disproved an entire theory about where a hang was.

## Current shape (2026-08-24)

Fleet Supervisor is **a plain Paseo plugin on stock, released Paseo**. There is
no patched build, no fork, no DOM injection, and no launcher.

| Path | What |
|---|---|
| `payload/fleet-supervisor-plugin/` | the plugin: settings surface, agent panel, command items, RPC handlers |
| `payload/src/fleet-guard.mjs` | the guard (daemon client, failover engine) |
| `payload/src/antigravity-acp.mjs` | ACP adapter for `agy` — verified, including a real turn |
| `payload/setup.mjs` | cross-platform install/uninstall + legacy cleanup |
| `payload/tests/` | contributions, ACP handshake, ACP turn, continuation engine |

Requires **Paseo 0.5.0+** (plugin support shipped there). `worktrees/paseo` and
`upstream-052/` are reference checkouts only — nothing ships from them.

### History worth knowing

Paseo 0.4.0 had no plugin system at all, so the buttons were once added either
by patching Paseo (composer/message action slots) or by injecting DOM. Both are
gone. `paseo-plugin-action-slots.patch` was deleted once 0.5.x shipped panels,
and upstream independently fixed the same two packaged-build bugs the patch
carried (esbuild path rewriting in `compiler.ts`, and a React-free
`@getpaseo/plugin/server` entry).

## Paseo plugin API (0.5.x)

Import from **`@getpaseo/plugin`**. `@paseo/plugin` still resolves as a compat
alias but is scheduled for removal after 2026-11-19.

`PluginContext` offers: `handle`, `addSurface`, `addSidebarItem`,
`addWorkspacePanel`, `addCommandCenterItem`, `addAttachmentSource`, `addTheme`.
**There is no composer or message action slot** — an agent-scoped
`addWorkspacePanel` is where buttons live.

### Two bundles, one entry

The plugin compiles twice. Per `compiler.ts`:

- **client**: every `node:*` import becomes `{}` (so `os.homedir` is not a
  function); React stack and SDK are external. `handle` calls are stripped.
- **server**: real Node. `addSurface`, `addSidebarItem`, `addWorkspacePanel`,
  `addCommandCenterItem`, `addAttachmentSource`, `addTheme` are stripped.

`contribute()` runs in **both**, so anything at module scope must survive both.
Entry is `index.ts`, with `index.tsx` still accepted as legacy.

### The external trap — read this twice

SDK specifiers are esbuild **externals**, so a name that does not exist is not
caught at build time. It resolves at runtime to `undefined`, and the plugin host
then calls `undefined.parseAsync(...)`, which throws **synchronously** — outside
the promise chain that would have replied. Symptom: an opaque

```
Plugin RPC timed out: <plugin>.<method>     (30s)
```

**Never invent entries in `paseo-plugin.d.ts`.** It is transcribed from real
source; check `packages/plugin/src/contracts.ts` at the release tag before
adding anything.

### `plugin ls` does not prove the UI works

`running` means the *server* bundle loaded. The buttons live in the client
bundle, which the daemon never evaluates. Use:

```bash
node payload/tests/plugin-contributions.test.mjs
```

It compiles the client bundle the way Paseo does, evaluates it against a mock
host, and asserts on every contribution. Also note **icons must be real Lucide
names** — `resolvePluginIcon` throws on anything else.

### Theme

`PluginTheme` supplies exactly six colours: `surface0`, `foreground`,
`foregroundMuted`, `accent`, `accentForeground`, `statusDanger`. There is no
border or raised surface — `readPalette` derives those by blending. Do not
hard-code dark defaults; they look fine in dark mode and unreadable in light.

## Managing the plugin

Use the installed Paseo's own CLI at
`<Paseo>/resources/bin/paseo.cmd` (Windows).

```bash
paseo plugin ls
paseo plugin reload fleet-supervisor    # after source edits
paseo plugin logs fleet-supervisor      # subprocess stdout/stderr
```

Do **not** restart the daemon to pick up plugin edits — it can kill a running
agent. Typecheck before every reload.

## Fleet Guard specifics

- **Always pass `appVersion` to `DaemonClient`.** Without it the daemon treats
  the client as pre-0.1.45 and shows only `claude`, `codex`, `opencode` — and
  those are the two you would test by hand.
- **An empty `council.members` is not "no reviewers."** `councilMembers()` falls
  back to the first three `fallbackOrder` entries with `kind === "paseo"` and a
  provider. The settings surface shows this explicitly.
- **Bridge probes must authenticate.** Every bridge route is bearer-authed, so
  an unauthenticated `/v1/status` probe gets 401. Treating that as "not running"
  once cost a 20s stall and a false "did not report ready" on every launch.
- `systemPrompt` is creation-only, and ACP providers silently drop it —
  `applyDirective` prepends it to the prompt instead.
- The bridge is loopback-only on `47641`, bearer-token authed, 2 MB cap.
- Don't `pkill -f fleet-guard` from an interactive shell; the pattern matches
  your own shell. Use `~/.paseo-fleet-guard/guard.pid`.

## Antigravity adapter

`agy` has **no ACP mode** (subcommands: agent, agents, changelog, help, install,
models, plugin, plugins, update), which is why Paseo cannot drive it directly.
The adapter supplies the agent side of ACP and advertises the Gemini catalogue,
so the provider shows up `ready` with 14 models.

Verified end to end, including a real turn returning assistant text.

```bash
node payload/tests/antigravity-acp.handshake.mjs   # no quota needed
node payload/tests/antigravity-acp.turn.mjs        # sends a real prompt
```

`agy`'s `step_update` events carry **no text** — the reply only appears in the
final `result.response`, so there is no token streaming to be had.

## Licensing

Fleet Guard is MIT. **Paseo is AGPL-3.0-or-later.** Redistributing a modified
Paseo binary triggers AGPL obligations (corresponding source, AGPL licensing,
modification notices). Nothing in this repo ships a Paseo build, and releases
deliberately contain Fleet Guard's own artifacts only.
