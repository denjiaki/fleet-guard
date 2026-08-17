# Fleet Supervisor — what changed and why

Everything here was built and verified against a real Paseo 0.4.0 daemon with a
real browser driving the UI, not just typechecked.

---

## 1. A bug in Fleet Guard you should fix regardless of everything else

`connectAndWatch` in `payload/src/fleet-guard.mjs` built its client like this:

```js
const candidate = new DaemonClient({
  url: config.daemonUrl,
  clientId: `fleet-supervisor-v4.0.0-beta.1-${process.pid}`,
  clientType: "cli",
  reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 5000 },
});
```

No `appVersion`. Paseo's daemon treats a client that omits it as pre-0.1.45 and
applies this filter (`packages/server/src/server/session.ts:1754`):

```js
private isProviderVisibleToClient(provider: string): boolean {
  if (clientSupportsAllProviders(this.appVersion)) return true;
  return LEGACY_PROVIDER_IDS.has(provider);   // {"claude", "codex", "opencode"}
}
```

So Fleet Guard could only ever see agents on **claude, codex and opencode**.
For anything else — cursor, copilot, antigravity, gemini, pi, omp, any ACP or
custom provider — `fetchAgents` silently returned nothing and `fetchAgent` threw
`Agent not found`.

Observed consequences:

- **Every Council review on a non-legacy agent failed.** This is how it was
  found: the first live Council run died at `fetchAgentSnapshot` with
  `Agent not found`, before a single reviewer spawned.
- The startup catch-up scan found nothing for those providers, so
  `catchUpWindowMinutes: 240` did not cover them.
- The shipped `fallbackOrder` contains `fleet-cursor` and `copilot`, both
  outside the legacy set.

It is easy to miss because the Claude-watch and Codex-handoff paths do work:
`claude` and `codex` are both on the allowlist, so the paths you would naturally
test by hand are the exempt ones.

Fixed by passing `appVersion`. After the fix the same Council run completed:

```
Council 59d94c19 started for b8b90758 with 3 configured model(s).
Council 59d94c19 returned 3 review(s) to original task b8b90758.
```

---

## 2. Files in this drop

| File | Goes to | What it is |
|---|---|---|
| `fleet-guard.mjs` | `payload/src/fleet-guard.mjs` | Patched: `appVersion` fix, subscription-cap awareness, provider/model catalog, config read/write, bridge router |
| `patch-fleet-guard.py` | keep alongside the repo | Reproduces those edits on a clean `fleet-guard.mjs`. Idempotent |
| `fleet-supervisor-plugin/` | `payload/fleet-supervisor-plugin/` | The Paseo plugin: settings surface, sidebar item, and the two buttons |
| `paseo-plugin-action-slots.patch` | a Paseo checkout | Adds the composer/message action slots to Paseo itself |

### What was replaced

`payload/fleet-supervisor-plugin/index.tsx` previously called
`plugin.addComposerAction()` and `plugin.addMessageAction()`, and the
`paseo-plugin.d.ts` beside it *declared* those methods. Stock Paseo 0.4.0 has no
such methods — `PluginContext` exposes only `handle`, `addSurface`,
`addSidebarItem` and `addAttachmentSource`. The plugin typechecked against a
declaration file that described an API which did not exist, and would have
failed validation at load.

The replacement `paseo-plugin.d.ts` describes the real SDK, and the plugin is
written against it.

---

## 3. Changes to `fleet-guard.mjs`

Beyond the `appVersion` fix:

- **`isSubscriptionCappedModel(provider, modelId)`** — true for Claude models
  matching `/(^|[-_/])fable/i`. This is what lets the UI distinguish Fable, which
  has its own weekly allowance and can usefully hand off to another Claude model,
  from every other Claude model, which exhausts the whole plan at once.
- **`providerCatalog(force)`** — providers and their models from the daemon's
  provider snapshot, cached for 60s. One snapshot already carries every model, so
  this avoids a per-provider probe; cold ACP discovery can take up to two minutes
  *per provider*.
- **`normalizeConfig` / `saveConfig`** — the settings surface can now write
  `config.json`. Applies the same defaults the loader uses, so a saved config
  reads back identically on next start.
- **Bridge router** — `handleBridgeRequest` previously 404'd anything that was
  not `POST /v1/council`. It now routes, ignores query strings, and adds:
  - `GET /v1/catalog[?refresh=1]`
  - `GET /v1/config`
  - `PUT /v1/config`

  All still behind the existing bearer token and loopback bind.

Conventions were matched deliberately: new config sections are deep-merged in
both the loader and `__setFleetGuardTestRuntime`, routes are literal
method+path comparisons, responses go through `sendBridgeJson`, and log lines are
full sentences.

---

## 4. The plugin

One `index.tsx` provides all three features.

**Settings surface** (`addSurface` + `addSidebarItem`) — a "Fleet Supervisor"
entry in Paseo's sidebar opening a settings screen. This replaces the C#
setup window and works on Windows, macOS and Linux with no extra packaging,
because Paseo renders it.

- **Set fallback order** — each entry expands into that provider's real,
  live-discovered models. Selecting Fable offers other Claude models; selecting
  any uncapped Claude model explains why it does not, rather than offering a
  choice that cannot work.
- **"Use for:"** — a switch per entry; on, it reveals Custom system prompt /
  Reporting progress / Bug checking / QA / Skepticism. Custom reveals a text box.
  These map to the `useFor` and `systemPrompt` fields `workerSystemPrompt`
  already consumes.
- **Council** — the reviewer roster, each with its own model and lens. Kept
  visually and structurally separate from the handoff roles, because a Council
  reviewer must not inherit "continue the task" behaviour.

**The two buttons** (`addComposerAction` + `addMessageAction`) — "Skeptic Review"
as a labelled pill in the composer toolbar, and a consensus icon in the action
row under each message. Both call `council.review`, which posts to the existing
bridge.

The plugin sends a **superset** of the payload your bridge already reads: it
flattens `text` / `role` / `attachments` / `images` to the top level for
`councilPrompt`, while also carrying the richer `context`, `draftText`,
`provider` and `model` fields. Your bridge works unchanged.

---

## 5. The two buttons need a decision from you

The buttons are the one part that cannot work on stock Paseo, because stock
Paseo has no composer or message action slot. Two ways to get them:

**Path A — apply `paseo-plugin-action-slots.patch`.** Adds the slots properly.
Buttons are real React components, styled natively, keyboard and screen-reader
accessible. This is the version worth sending to getpaseo as a PR. Cost: users
need a Paseo built from the patched source.

Applying it:

```bash
git clone https://github.com/getpaseo/paseo && cd paseo
git am < paseo-plugin-action-slots.patch
npm ci && npm run build:desktop
```

It passes Paseo's own pre-commit hooks — format, lint, and a full typecheck
across all twelve workspaces — and adds 6 tests to `evaluate.test.ts`. 769 app
tests pass.

**Path B — DOM injection, no fork.** Paseo's plugin loader evaluates plugin
client code in the renderer with `document` reachable, and its components carry
stable `testID`s that react-native-web emits as `data-testid`. A plugin using
only the *existing* API can therefore inject buttons into an unmodified Paseo.
This was tested and works — a plugin-injected button appeared in the composer
toolbar of a stock build and its click handler fired.

Path B needs no rebuild and no separate download, which is the better answer for
your users. Its one real cost: the renderer cannot read files, so an injected
button cannot authenticate to the bridge with the token from
`~/.paseo-fleet-guard/bridge-token`. The bridge would have to accept loopback
requests without a filesystem-derived secret. Worst case is another local
process triggering a Council review and spending your own model quota — not
credential exposure — but it is genuinely weaker than Path A.

---

## 6. What is not done

- **Folding Fleet Guard into the Electron main process.** The settings surface
  removes the main reason the C# setup app existed, so this is now smaller than
  it was, but the launcher and installer are still Windows-only.
- **Cross-platform release CI.** Electron apps cannot be cross-compiled for
  macOS from Linux; a three-runner GitHub Actions workflow modelled on Paseo's
  own `desktop-release.yml` is the way to get all three platforms.
- **Path B implementation.** Proven feasible, not yet written as a shipping
  plugin.

---

## 7. How this was verified

A Paseo 0.4.0 daemon with the plugin installed, the patched web UI served to a
headless Chromium, and Fleet Guard running against it with a three-model Council
roster on the `mock` provider.

- Both buttons render, and are present in the DOM with the right accessibility
  labels.
- Clicking Skeptic Review round-trips: browser → daemon → forked plugin process →
  handler → bridge → Fleet Guard → three reviewer agents → digest posted back
  into the original conversation.
- The settings surface loads real models, shows the correct Fable / non-Fable
  branch, and `Save` persists to `config.json` on disk.

One caveat on the Council screenshots: all three reviews read identically because
the `mock` provider emits the same synthetic stream regardless of prompt. What is
proven is the orchestration, not review quality.
