# CLAUDE.md — Fleet Supervisor / Fleet Guard

Working notes for agents on this repo. Everything here was paid for in debugging
time; read it before touching Paseo integration.

## The one rule

**Verify against the binary the user actually runs.** Two prior agents shipped
confident, wrong handoffs on this project by verifying somewhere convenient
instead. If you cannot verify something, say so — in the report, the commit
message, the README, and the code. Do not imply it works.

Cheap checks that would have caught both failures:

```powershell
# Does the SHIPPED app actually have the feature?
$b=[IO.File]::ReadAllBytes("$env:LOCALAPPDATA\Programs\Paseo\resources\app.asar")
([regex]::Matches([Text.Encoding]::ASCII.GetString($b),'pluginsEnabled')).Count
```

Prefer a cheap empirical probe over reasoning from source. A 400 response in
177 ms once disproved an entire theory about where a hang was.

## Layout

| Path | What |
|---|---|
| `worktrees/fleet-guard/` | this repo, branch `fleet-supervisor-v4` |
| `worktrees/paseo/` | Paseo source, **patched**, post-0.4.0 `main` |
| `payload/src/fleet-guard.mjs` | the guard (daemon client, failover engine) |
| `payload/fleet-supervisor-plugin/` | the Paseo plugin (settings + buttons) |
| `payload/src/antigravity-acp.mjs` | ACP adapter for `agy` (experimental) |
| `paseo-plugin-action-slots.patch` | all Paseo-side changes, `git am`-able |

Paseo-side changes live only as that patch. **Regenerate it after any change
under `worktrees/paseo`**, or the pushed repo is silently stale:

```bash
cd worktrees/paseo && git add <paths> && git commit --amend --no-edit
git format-patch -1 --stdout > ../fleet-guard/paseo-plugin-action-slots.patch
```

## Paseo plugin system

Plugin support landed on upstream `main` **2026-08-14**, the day after v0.4.0
shipped. **No released Paseo has it** — tag `v0.4.0` has no
`packages/server/src/server/plugins` directory. A stock install cannot render
the buttons or the settings surface, and **refuses to start** if the config
carries `plugins`/`pluginsEnabled` (strict schema, unknown keys are fatal):

```
[Config] Invalid config in ~/.paseo/config.json:
  - : Unrecognized keys: "pluginsEnabled", "plugins"
```

The daemon exits 1 before writing to `daemon.log`, so **look in
`%APPDATA%\Paseo\logs\main.log`**, not `~/.paseo/daemon.log`, when Paseo won't
start.

### One `index.tsx`, two bundles

The plugin is compiled twice. Per `compiler.ts`:

- **client** bundle: every `node:*` import becomes `{}` (so `os.homedir` is not
  a function), `react`/`react-native` are external
- **server** bundle: real Node; `react`/`react-native` become `{}`

`contribute()` runs in **both**. Anything at module scope must survive both, and
registration calls for the other target are stripped from the source before
esbuild sees it.

### The `@paseo/plugin` external trap — read this twice

`@paseo/plugin` is an esbuild **external**, so a name that does not exist is not
caught at build time. It resolves at runtime to `undefined`, and
`plugin-process.ts` then calls `undefined.parseAsync(...)`, which throws
**synchronously** — outside the promise chain that would have replied — and the
plugin's own `shieldDaemonProcess()` swallows it. Symptom: an opaque

```
Plugin RPC timed out: <plugin>.<method>     (30s, REQUEST_TIMEOUT_MS)
```

with no error anywhere. This is what broke Skeptic Review completely.

**Never trust `paseo-plugin.d.ts`.** It is a local declaration file and has
twice declared exports that do not exist. Check
`worktrees/paseo/packages/plugin/dist/index.d.ts` for what is real.

The host does not export a payload schema. Action payloads are built inline in
`packages/app/src/plugins/actions.tsx` and are **flat**:

```js
{ scope: "latest-context", agentId, workspaceId }
{ scope: "message", agentId, messageId, role, text, attachments, images }
```

### Timeouts

Paseo abandons a plugin RPC at **30 s**. Any bridge/network wait inside a
handler must be shorter, or the real error never surfaces.

## Packaged-build traps

Both of these break **every** plugin in an installed Paseo, and both are fixed
in the patch:

1. **esbuild** — the daemon compiles plugins with esbuild, which spawns a native
   binary. It sits in `app.asar.unpacked` but resolves inside `app.asar`, which
   cannot be executed → `spawn ...esbuild.exe ENOENT`. Fixed by setting
   `ESBUILD_BINARY_PATH` in the daemon env.
2. **react** — importing the `@paseo/plugin` root pulls in `rpc-context.js`,
   which imports the `react` peer dependency, absent from the daemon's packaged
   tree → `ERR_MODULE_NOT_FOUND`. Fixed with a React-free
   `@paseo/plugin/server` entry.

**Why #2 hid for so long, and the general lesson:** `release/win-unpacked` lives
*inside* the repo, so Node resolves `react` from the workspace root by walking
up parent directories. It only reproduces once installed somewhere with no
`node_modules` above it. **An in-repo build is not proof of a packaged build.**

## Building Paseo

```bash
cd worktrees/paseo
npm run build:plugin                                   # after packages/plugin changes
npm run build --workspace=@getpaseo/desktop            # server + main + installer
```

- **Close Paseo first.** A running `Paseo.exe` locks the output dir; the error
  names `app-builder` / `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`, and the real
  cause is the line above: `remove ...\Paseo.exe: Access is denied`.
- The installer needs **Developer Mode** (symlink privilege). `win-unpacked`
  builds fine without it.
- **Delete `resources/app-update.yml` after every build/install.** It points at
  upstream `getpaseo/paseo`; an update replaces the patched build with stock
  Paseo and reproduces the startup failure above.
- Renderer-only change? Rebuild the app bundle and copy it to
  `release/win-unpacked/resources/app-dist` — it is loaded from outside
  `app.asar`, so no repackage is needed.

Pre-existing failures, not yours: `draggable-list.native.tsx:122` fails
typecheck, and 11 desktop test files fail with `Electron failed to install
correctly` (missing `node_modules/electron/dist`).

## Fleet Guard specifics

- **Always pass `appVersion` to `DaemonClient`.** Without it the daemon treats
  the client as pre-0.1.45 and shows only `claude`, `codex`, `opencode`. Hides
  well, because those are the two you would test by hand.
- **An empty `council.members` is not "no reviewers."** `councilMembers()` falls
  back to the first three `fallbackOrder` entries with `kind === "paseo"` and a
  provider. The settings surface now shows this explicitly.
- `systemPrompt` is creation-only, and ACP providers silently drop it —
  `applyDirective` prepends it to the prompt instead.
- The bridge is loopback-only on `47641`, bearer-token authed, 2 MB cap.
- Don't `pkill -f fleet-guard` from an interactive shell; the pattern matches
  your own shell. Use `~/.paseo-fleet-guard/guard.pid`.

## Antigravity adapter (experimental)

`agy` has **no ACP mode** (subcommands: agent, agents, changelog, help, install,
models, plugin, plugins, update), which is why Paseo cannot drive it directly.
The adapter supplies the agent side of ACP.

Verified: handshake, session lifecycle, cancel, model changes, catalogue (14
Gemini models live in Paseo), and error propagation.
**Unverified: a successful turn.** The account was quota-limited throughout.

```bash
node payload/tests/antigravity-acp.handshake.mjs   # no quota needed
node payload/tests/antigravity-acp.turn.mjs        # needs quota — the real check
```

If the turn test prints `TURN VERIFIED`, drop the experimental wording from
`README.md`, `docs/antigravity-acp.md`, and the adapter's header comment.

Note `agy`'s `step_update` events carry **no text** — the reply only appears in
the final `result.response`, so there is no token streaming to be had.

## Licensing

Fleet Guard is MIT. **Paseo is AGPL-3.0-or-later.** Redistributing a modified
Paseo binary triggers AGPL obligations (corresponding source, AGPL licensing,
modification notices). Do not publish a built Paseo without deciding that
deliberately.
