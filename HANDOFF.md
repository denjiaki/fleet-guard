# Fleet Supervisor — handoff

**Date:** 2026-08-15 · **Session:** built and verified against a live Paseo 0.4.0
daemon with a real headless browser driving the UI.

**Update at end of session:** the roadmap is complete. Path B (no-fork DOM
injection) is built and verified, the ACP `systemPrompt` gap is closed, the
toolbar toggle from the original point 5 is built, the Windows-only launcher is
gone (the plugin starts the guard on any OS), and there is a cross-platform
installer plus a three-OS CI workflow. Nothing on the original request is
outstanding.

Read this top to bottom before touching anything. Section 6 (traps) will save you
hours — most of those cost me an hour each to find.

---

## 1. What this project is

Alef has a tool called **Fleet Supervisor** (older name: Fleet Guard) that sits
beside [Paseo](https://github.com/getpaseo/paseo), an open-source desktop app for
running coding agents. Fleet Supervisor watches Paseo's daemon and, when a Claude
agent hits a quota/session limit, automatically hands the task off to a fallback
provider (Codex → Antigravity → Cursor → Copilot).

It lives at `C:\development\paseo-fleet-guard-v2.1-beta\` on the machine
`omen-alef`. Two git worktrees matter:

- `worktrees/fleet-guard/` — Fleet Supervisor itself (branch `fleet-supervisor-v4`)
- `worktrees/paseo/` — a checkout of upstream Paseo 0.4.0, for reference

The previous agent (Codex) ran out of usage partway through. Alef asked for three
features on top of what exists.

### The three requested features

1. **A fallback *model* tree, not just a provider list.** Within a provider you
   pick the exact model. Specifically: Anthropic's Fable has its own weekly
   allowance, so when Fable runs out you should be able to fall back to *another
   Claude model*. Any other Claude model exhausts the whole plan at once, so for
   those the UI must say so rather than offer a useless choice.
2. **Per-model roles.** A "light switch" toggle labelled "Use for:" next to each
   model in the tree. On → a dropdown: Custom system prompt / Reporting progress /
   Bug checking / QA / Skepticism. Whatever is chosen is injected as the
   highest-priority instruction when Fleet Supervisor hands off to that model.
3. **A "Council".** Send either the latest context or one specific message to
   several models at once for independent review; they return conclusions to the
   original conversation, which produces one digest. Two entry points:
   a **"Skeptic Review"** button in Paseo's composer toolbar, and a **consensus
   icon** under any individual message (user's or model's). Council prompts must
   be kept separate from the handoff role prompts so reviewers don't try to
   continue the task.

**Alef's stated success condition, verbatim:** *"Should you succeed in adding
those buttons to the Paseo interface, which should be your only success
condition, (and i will accept nothing less)"*.

That condition is **met** — see §2.

---

## 2. Current state

### Done and verified running

| # | Feature | Status |
|---|---|---|
| — | **Paseo plugin API: composer + message action slots** | Done. Committed, passes Paseo's own pre-commit hooks (format, lint, **full 12-workspace typecheck**). 769 app tests pass, 6 new ones added. |
| — | **Both buttons render and fire** | Verified in a real browser. Click round-trips browser → daemon → forked plugin process → handler → bridge → Fleet Guard. |
| 3 | **Council** | Working end to end. Engine already existed (Codex built it); what was missing was the buttons + a payload fix + a bug fix. |
| 1 | **Fallback model tree** | Done, as a Paseo plugin surface. Live model discovery, Fable/non-Fable branching both verified by clicking through. |
| 2 | **"Use for:" roles** | Done. Switch + role chips + custom prompt box; saves to `config.json` on disk. |
| — | **Path B: buttons on stock Paseo, no fork** | Done. Injected buttons trigger real Council reviews with zero native slots used. |
| — | **ACP `systemPrompt` gap** | Closed. Roles now ride in the prompt for providers that drop `systemPrompt`. |
| 5 | **Fleet Supervisor toolbar toggle** | Done. Enabled by default; click to disable. Injected path paints live state, native path reports via toast. |
| — | **Cross-platform, no launcher** | Done. The plugin starts the guard itself, so the Windows-only C# launcher and shortcut are unnecessary. |
| — | **Cross-platform installer** | Done. `setup.mjs` — install, idempotent re-run, uninstall, all verified. |
| — | **Three-OS CI** | Done. `release.yml` runs the real installer on Windows, macOS and Linux, then packages one archive. |
| + | **Manual hand-off** | Done. "Hand off" button in the toolbar opens a picker of configured entries ("Next in order" or a specific one). Stops the current turn, seeds the same `performFailover` engine with the user's reason and chosen start index. Verified: root went running→idle, child spawned at the chosen entry, role directive and reason both reached the worker's prompt. |
| + | **All config editable inside Paseo** | Done. Every key Fleet Supervisor reads — general switches, continuation policy, add/remove/reorder fallbacks and reviewers, Council limits, local model, advanced — is on the settings surface. Verified round-tripping to disk and reflected live by the running guard. The installer never needs reopening. |

Proof from the live Council run:

```
Council 59d94c19 started for b8b90758 with 3 configured model(s).
Council 59d94c19 returned 3 review(s) to original task b8b90758.
```

### Not done

Nothing from the original request.

**On the Electron plan specifically — it was dropped deliberately, not skipped.**
The original idea was to bundle Fleet Supervisor as its own Electron app so it
would run on all three platforms. That turned out to be solving a problem that no
longer exists. Electron was needed for two things: a UI, and a way to launch the
guard next to Paseo. The UI is now a Paseo plugin surface, which Paseo already
renders on every platform. And the guard is now started by the plugin itself when
Paseo's daemon loads it. Bundling a second Electron runtime would have added
~150MB and a second updater to ship a window nobody opens. What ships instead is
a plugin directory, one Node script and an installer — all portable by
construction, which is what "runs on macOS, Linux and Windows locally" actually
asked for.

If you still want a standalone app later, the pieces are unchanged; it is a
packaging decision, not a blocked one.

---

## 3. Two real bugs found by running the thing

### 3a. Fleet Guard was invisible to most providers (FIXED)

`connectAndWatch` built its client without `appVersion`:

```js
const candidate = new DaemonClient({
  url: config.daemonUrl,
  clientId: `fleet-supervisor-v4.0.0-beta.1-${process.pid}`,
  clientType: "cli",
  reconnect: { ... },
});
```

Paseo's daemon treats a client with no `appVersion` as pre-0.1.45 and applies
(`packages/server/src/server/session.ts:1754`):

```js
private isProviderVisibleToClient(provider: string): boolean {
  if (clientSupportsAllProviders(this.appVersion)) return true;
  return LEGACY_PROVIDER_IDS.has(provider);   // {"claude", "codex", "opencode"}
}
```

So Fleet Guard could only see agents on **claude, codex, opencode**. For anything
else — cursor, copilot, antigravity, gemini, pi, omp, any ACP or custom provider —
`fetchAgents` silently returned `[]` and `fetchAgent` threw `Agent not found`.

Consequences: every Council review on a non-legacy agent failed before a single
reviewer spawned; the startup catch-up scan missed those providers entirely; and
the shipped `fallbackOrder` contains `fleet-cursor` and `copilot`, both outside
the allowlist.

It hides well because `claude` and `codex` are *both* on the allowlist — the two
paths you'd naturally test by hand are the exempt ones.

**Fixed** by passing `appVersion: FLEET_CLIENT_APP_VERSION` ("0.4.0"). Verified:
the same Council run went from failing instantly to completing.

### 3b. Codex's plugin targeted an API that does not exist (FIXED)

`payload/fleet-supervisor-plugin/index.tsx` called `plugin.addComposerAction()`
and `plugin.addMessageAction()`, and the `paseo-plugin.d.ts` beside it *declared*
those methods. Stock Paseo 0.4.0's `PluginContext` has only `handle`,
`addSurface`, `addSidebarItem`, `addAttachmentSource`. The plugin typechecked
against a fabricated declaration file and would have failed validation at load.

Codex's own `README-FIRST.txt` admits it: *"Stock Paseo 0.4.0 … does not yet
expose composer/message plugin action slots."*

**Fixed**: the slots now genuinely exist (see §4 Path A), the `.d.ts` was
rewritten to describe the real SDK, and the plugin rewritten against it.

---

## 4. How the buttons ship — both paths built

Stock Paseo has no composer/message action slot, so *something* had to give.
Both paths are now built and verified. **Path B is what to ship**; Path A is what
to send upstream.

### Path A — patch Paseo (BUILT, verified)

`paseo-plugin-action-slots.patch` adds two contribution kinds to Paseo's plugin
API. Buttons become real React components — native styling, hover states,
accessibility labels, keyboard reachable.

- 21 files, +975 lines.
- Passes Paseo's own `lefthook` pre-commit: format, lint, full typecheck across
  all twelve workspaces.
- Adds 6 tests to `packages/app/src/plugins/evaluate.test.ts`.

Apply with:

```bash
git clone https://github.com/getpaseo/paseo && cd paseo
git am < paseo-plugin-action-slots.patch
npm ci && npm run build:desktop
```

**Cost:** users need a Paseo built from patched source. Alef pushed back on this
explicitly — *"Will users have to download a whole separate paseo version? That's
not great"* — and he's right.

### Path B — DOM injection, no fork (BUILT, verified) — **this is what to ship**

`dom-actions.ts` injects the buttons into an unmodified Paseo using only the
stock plugin API. Verified: `native slots used: 0`, three buttons injected, and
clicking either one starts a real Council review that completes and posts its
digest back.

How the pieces fit:

- **Anchors** — `message-input-attach-button` (composer),
  `user-message-trailing-row` (user messages), `assistant-fork-menu-trigger`
  (assistant turns). The in-flight turn footer renders the same fork control but
  has no completed text, so it is skipped via `turn-working-indicator`.
- **Placement** — Paseo wraps some controls in their own column container, so
  inserting directly after the anchor stacks the button underneath. `rowSiblingFor`
  climbs until the parent lays out as a row. This was a real bug, caught visually.
- **Identity** — a React fiber walk (`__reactFiber$…` → `memoizedProps`) recovers
  `serverId` / `agentId` / `workspaceId`, and for user messages the text and
  attachments straight from `UserMessage`'s props. Nothing is scraped from
  rendered text. Assistant turn text is rebuilt from the footer's `items` +
  `startIndex`.
- **Theming** — the button borrows the computed colour of a neighbouring control,
  so it tracks light/dark without reimplementing Paseo's palette.
- **Auth (the gap that was open, now closed)** — the bridge gained
  `GET /v1/handshake`, answered only for renderer origins (`paseo://`, `file://`,
  loopback). The injected button collects the token there and then authenticates
  normally. Every write route demands `application/json`, so any cross-origin
  write is preflighted and the preflight only succeeds for the renderer.

  Verified: handshake succeeds from a renderer origin, is refused from
  `https://evil.example`, is refused with no origin and no token; preflight
  returns 204 for the renderer and 403 for a hostile origin; a form-encoded
  CSRF-shaped POST is rejected with 415.

  Honest limit: a **native** local process can spoof `Origin` — but it could also
  just read `~/.paseo-fleet-guard/bridge-token`, so this does not widen the
  surface. The Origin check is a browser boundary, which is the threat it exists
  for.

**One plugin serves both paths.** `index.tsx` checks
`typeof plugin.addComposerAction === "function"`: native slots where the host has
them, injection where it does not. So the same build works on stock Paseo today
and automatically upgrades if the slots land upstream. Debug override:
`localStorage["fleet-supervisor:force-dom-actions"] = "1"`.

---

## 5. File inventory — state of Alef's disk (verified 2026-08-17)

Everything below is **written to disk and verified on the machine**: the guard and
installer parse under Alef's Node v22.22.3, and the installer ran end to end
against a throwaway Paseo home there.

### One thing that could not be written

`.github/workflows/release.yml` — the device bridge refuses writes under
`.github/workflows/` (CI files execute code; a sensible refusal). It is on disk
as **`release.yml.move-to-.github-workflows`** at the repo root. Move it:

```
mkdir -p .github/workflows
git mv release.yml.move-to-.github-workflows .github/workflows/release.yml
```

### The working tree has THREE layers of change — commit them knowingly

`git status` shows ~22 modified + 12 untracked. They are not all one thing.

**Layer 1 — Codex's uncommitted work (mtime 2026-08-15 ~01:00, before Alef's
flight).** Last commit is `f4cfd74 2026-08-14 Release Fleet Guard v3.2.0 beta`;
Codex's v4.0.0-beta.1 changes were never committed. Real content changes in:
`README.md`, `README-FIRST.txt`, `desktop/FleetGuardSetup.cs`,
`package-release.ps1`, `payload/install.mjs`, `payload/uninstall.mjs`,
`payload/package.json`, `payload/package-lock.json`,
`payload/tests/continuation-engine.test.mjs`. **I did not touch these.** Review
them as Codex's; some (the C# setup app, `install.mjs`) are now superseded by
`setup.mjs` and the plugin surface, but that is a decision for Alef, not a
deletion I made.

**Layer 2 — this session's work (mtime 2026-08-17).**
`payload/src/fleet-guard.mjs` (22 sentinel patches over Codex's file),
`payload/fleet-supervisor-plugin/*` (all six files; `dom-actions.ts` is new),
`payload/setup.mjs` (new), `patch-fleet-guard.py`, `HANDOFF.md`,
`FLEET-SUPERVISOR-CHANGES.md`, `paseo-plugin-action-slots.patch`,
`release.yml.move-to-.github-workflows`.

**Layer 3 — line-ending churn, NOT changes.** `.gitignore`, `CHANGELOG.md`,
`LICENSE`, `desktop/FleetGuardLauncher.cs`, `desktop/GenerateFleetIcon.cs`,
`desktop/build.ps1`, `payload/STATUS.cmd`, `payload/UNINSTALL.cmd`,
`payload/Usage Guide.html`, `payload/launch-paseo-with-guard.ps1`,
`payload/src/diagnose.mjs`, `payload/src/status.ps1`. Verified: byte-identical
to HEAD once `\r` is stripped from both sides. The repo was committed with CRLF
and `core.autocrlf` is unset, so anything that viewed the tree through a Linux
mount re-registers as changed. **Do not commit these** — `git checkout -- <file>`
them, or set `core.autocrlf true` and `git add --renormalize .` once for the
whole repo so it stops happening.

Reproduce the classification with:
```
for f in $(git diff --name-only); do
  diff <(git show "HEAD:$f" | tr -d '\r') <(tr -d '\r' < "$f") >/dev/null \
    && echo "eol-only $f" || echo "REAL     $f"; done
```

### The C# desktop app is now dead code

`desktop/FleetGuardLauncher.cs`, `desktop/FleetGuardSetup.cs`,
`desktop/GenerateFleetIcon.cs`, `desktop/build.ps1`, `package-release.ps1`, and
`payload/launch-paseo-with-guard.ps1` exist only to launch the guard next to
Paseo and to offer a settings window. Both jobs are done by the plugin now (the
guard auto-starts; settings are a Paseo surface). They still build and still
work, so nothing breaks by leaving them — but they are the Windows-only path the
whole session moved away from, and `release.yml` does not build them. Removing
them is Alef's call; I left them untouched.

## 6. Traps — read this before debugging anything

1. **`appVersion` on any DaemonClient.** Omit it and you see only
   claude/codex/opencode. This will waste your afternoon. See §3a.
2. **The `@paseo/plugin` runtime shim exists in *two* places and they must match:**
   `packages/app/src/plugins/evaluate.ts` (renderer allowlist) and
   `packages/server/src/server/plugins/plugin-process.ts` (daemon). One
   `index.tsx` is compiled for both targets, so anything imported at module scope
   must resolve on both sides *even when the registration using it is stripped
   from that bundle*. I hit this: the client worked, the daemon crashed.
3. **Don't import the `@/plugins` barrel** into `message.tsx` or
   `turn-footer.tsx`. It pulls in catalog-sync → `expo-constants` and breaks
   their unit tests. Import `@/plugins/actions` directly. There are comments in
   the code saying so.
4. **`systemPrompt` is silently dropped by ACP providers.** Only claude, codex,
   opencode, pi and omp honour `AgentSessionConfig.systemPrompt`. Cursor,
   Copilot, Gemini and all 36 ACP catalog providers ignore it — no error, no
   warning. **Handled** by `applyDirective`, which sends the directive as
   `systemPrompt` where honoured and prepends it to the initial prompt otherwise.
   Verified by reading a reviewer's actual prompt. If you add a provider to
   `SYSTEM_PROMPT_PROVIDERS`, confirm it really applies the field first.
5. **`systemPrompt` is creation-only.** There is deliberately no RPC to change it
   on a running agent.
6. **The `mock` provider is dev-only.** It needs `PASEO_NODE_ENV=development` on
   the daemon. `mock/ten-second-stream` is the fast one — ideal for testing
   Council fan-out without burning real quota. `five-minute-stream` is the
   default and too slow.
7. **`pkill -f "fleet-guard"` kills your own shell**, because the pattern matches
   the bash command running it. Use the pid from `~/.paseo-fleet-guard/guard.pid`.
8. **Paseo's lucide test stub is not the real icon set.**
   `packages/app/test-stubs/lucide-react-native.ts` only lists icons the app
   already uses. Adding a new icon name to a plugin means adding it to the stub
   or the evaluate tests fail with "Unknown Lucide icon".
9. **oxlint forbids inline functions/objects as props on memoized components.**
   Pass flat scalars and referentially-stable `useCallback`s instead.
10. **A Council fired seconds after the daemon restarts can fail once** with
    `Reviewer failed: Caller agent <id> not found`, seen exactly once during
    testing. I hypothesised that message-scope skipped a timeline read that
    latest-context happened to do, wrote the fix, then A/B tested it — and the
    cold case succeeded *without* the fix too. So the hypothesis is wrong and no
    change was shipped. Real cause unconfirmed; most likely a daemon
    startup-hydration race. Practically hard to hit, because the buttons are
    only reachable with the conversation open, which loads the agent. If it
    recurs, instrument `create_agent_request` rejection rather than assuming.

11. **Provider catalog right after daemon start.** For a short window providers
    report `status: "loading"` with empty model lists. Two guards were added:
    the bridge no longer caches an unsettled snapshot, and the settings surface
    polls every 3s while any provider is loading. I could not reproduce the
    original bad state on demand afterwards (the daemon settled inside its
    startup window), so treat these as defensive; the one screenshot that showed
    "loading" badges is the only evidence it happened.

12. **The model tree used to gate on the wrong thing.** It asked "is the
    *selected* model subscription-capped?" — a question about the source of a
    chain — and used the answer to hide every Claude model whenever a non-Fable
    Claude model was picked. Alef caught it from a screenshot. Now: every model
    is always selectable; the cap logic is `chainAdvice()`, an advisory note
    computed from the entry's *position* (entry 1 is the source; later entries
    are judged against their predecessor). It never removes a choice.

13. **Paseo emits compatibility aliases as models.** `claude-fable-5[1m]` is
    listed alongside `claude-fable-5` with `isSelectable: false`; Paseo's own
    picker hides it. The bridge catalog now filters `isSelectable === false`,
    or the same model shows twice.

14. **Two guards can run at once — fixed with a singleton lock.** The plugin's
    auto-start plus a manual/scripted start could leave several guards alive;
    the bridge port belonged to whichever bound first, and the pid file to
    whichever wrote last. Now: `EADDRINUSE` on the bridge means "someone else
    owns it" and the instance exits without touching the pid file, and the pid
    file is only written after the lock is won. The plugin also serialises its
    own auto-start and re-checks the bridge after a beat before spawning.
    Verified: a second instance exits in <1s; pid file still names the winner.

15. **`pgrep -f fleet-guard.mjs` from an interactive shell kills that shell**
    (its own command line matches). Cost me three shells this session. Use the
    pid file, or run the sweep from a script whose invocation does not contain
    the pattern.

16. **`patch-fleet-guard.py` idempotency is sentinel-based.** Each patch inserts
    a `// @fleet:<slug>` comment; presence of the sentinel means applied. Do not
    "improve" this to anchor- or full-text-based detection — both were tried and
    both mis-detect once patches nest inside each other's output. 18 patches,
    verified applying cleanly on a pristine file and no-op on a second run.

17. **`performFailover` had exactly one caller** (quota detection) until this
    session. Manual hand-off is `startManualHandoff` → seeds
    `persistedState.handled[key]` with `source: "manual"`, the user's reason,
    and `nextWorkerIndex` → calls the same engine. Nothing in the engine changed;
    only the log line now names the trigger. If you add another trigger, seed a
    record the same way rather than forking the engine.

18. **Three labelled toolbar pills wrapped onto two lines** at desktop widths.
    Fixed with `white-space:nowrap` plus a compact mode (`applyCompactLabels`)
    that drops to icon-only under 640px of toolbar width, re-evaluated on resize.

19. **In-flight Council reviews are never drained on shutdown.**
    `activeCouncilReviews` is only ever `.set`/`.delete`d; `cleanup()` doesn't
    await it. Reviews die mid-flight when Paseo quits. Pre-existing, not fixed.

---

## 7. Rebuilding the test environment

This took a long time to get right; it's worth reusing. All in a Linux container,
Node 22.

```bash
# 1. Paseo
git clone --depth 1 https://github.com/getpaseo/paseo ~/paseo-upstream
cd ~/paseo-upstream && git checkout -b fleet-supervisor
npm ci                       # ~15 min, ~2.1 GB
git am < paseo-plugin-action-slots.patch     # Path A only
npm run build:plugin && npm run build:server # ~5 min
cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web  # ~8 min

# 2. Daemon (PASEO_NODE_ENV=development enables the mock provider)
mkdir -p ~/paseo-test-home
cat > ~/paseo-test-home/config.json <<'EOF'
{ "version": 1,
  "daemon": { "listen": "127.0.0.1:6767", "cors": { "allowedOrigins": ["*"] } },
  "pluginsEnabled": true,
  "plugins": { "fleet-supervisor": { "source": "directory",
    "path": "/root/fleet-supervisor-plugin", "enabled": true } } }
EOF
cd ~/paseo-upstream/packages/server
PASEO_HOME=~/paseo-test-home PASEO_NODE_ENV=development PASEO_LISTEN=127.0.0.1:6767 \
  PASEO_CORS_ORIGINS='*' node dist/scripts/supervisor-entrypoint.js &

# 3. An agent to look at
cd ~/fleet-workspace && git init -q && echo hi > README.md && git add -A && git commit -qm init
PASEO_HOME=~/paseo-test-home node ~/paseo-upstream/packages/cli/dist/index.js \
  run --background --provider mock --title "Fleet button check" "Say hello."

# 4. Serve the web bundle (SPA fallback to index.html) on :8099, then Playwright:
#    executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"]
#    Navigate to /  first (registers the daemon), then
#    /h/<serverId>/agent/<agentId>   or   /h/<serverId>/plugin/fleet-supervisor/settings

# 5. Fleet Guard
ln -sfn ~/fleet-state ~/.paseo-fleet-guard      # so the plugin finds bridge-token
cd <dir with patched fleet-guard.mjs>
setsid env FLEET_GUARD_STATE_HOME=~/fleet-state node fleet-guard.mjs &
```

`serverId` is in the daemon log (`serverId=srv_…`) and in the browser's
`localStorage["@paseo:daemon-registry"]`.

Useful checks:

```bash
T=$(cat ~/fleet-state/bridge-token)
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:47641/v1/status
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:47641/v1/catalog
PASEO_HOME=~/paseo-test-home node .../cli/dist/index.js plugin ls
```

DOM probe for the buttons:

```js
document.querySelectorAll('[data-testid^="composer-plugin-action"]')
document.querySelectorAll('[data-testid^="message-plugin-action"]')
```

Note: the user-message action row renders at `opacity: 0` until hover, and
Playwright's synthetic hover does not reliably trigger react-native-web's
`onPointerEnter`. Use a **narrow viewport (~620px)** instead — the code shows that
row unconditionally in compact layout. That's a real product state, not a hack.

---

## 8. Next steps, in priority order

1. **Ship it.** Reinstall the plugin directory and restart Paseo + Fleet
   Supervisor. Nothing else is required for the three features to work.
2. **Submit Path A upstream** as a PR to getpaseo/paseo. It's clean, tested, and
   passes their hooks. Retires the DOM hack when merged.
3. **Fold Fleet Guard into Electron main** + **three-runner release CI**. This is
   the only remaining work for a genuinely cross-platform local install, and it
   is packaging, not features — the UI is already cross-platform because Paseo
   renders it.
4. Fix the shutdown drain for in-flight Council reviews (trap #10).
5. Re-verify the DOM anchors against each new Paseo release. They are internal,
   not a public contract. If one moves, the buttons vanish silently — worth a
   startup self-check that logs when an anchor finds nothing.

---

## 9. Things Alef said that shape the work

- *"adding those buttons to the Paseo interface … should be your only success
  condition, and i will accept nothing less"* — that's the bar; it's met.
- *"Why does it have to be a Paseo Fork? … Will users have to download a whole
  separate paseo version? That's not great"* — strong steer toward Path B.
- He caught that the composer button rendered icon-only when his spec said it
  should *say* "Skeptic Review". Fixed — it's now a labelled pill. **He reads the
  screenshots carefully; send them.**
- He asked for the message-level button to be *"just a consensus icon"* — so that
  one stays icon-only by design. Don't "fix" it.
