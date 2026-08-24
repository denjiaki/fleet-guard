<p align="center">
  <img src="docs/assets/fleet-guard.png" width="190" alt="Fleet Guard icon">
</p>

<h1 align="center">Fleet Guard</h1>

<p align="center">
  A friendly Windows companion for Paseo that keeps long-running Claude jobs moving when a session limit gets in the way.
</p>

<p align="center">
  <a href="https://github.com/denjiaki/fleet-guard/releases/latest"><strong>Fleet Supervisor 4 beta</strong></a>
  ·
  <a href="#getting-started">Getting started</a>
  ·
  <a href="#how-it-continues-a-job">How it works</a>
</p>

> **Beta software:** Fleet Guard is useful today, but it is still young. Keep an eye on important work and report anything surprising.

Fleet Guard watches a root Claude Code task inside [Paseo](https://paseo.sh/). When Claude reports a real session or quota limit, Fleet Supervisor hands the same workspace and task context to the exact provider **and model** you chose—including another Claude model or a model running locally on your PC. It can nudge an unfinished agent, check a premature completion claim, cycle through fallbacks, and return the work to the original Claude task after a cooldown.

Version 4 also adds multi-model review to Paseo itself. **Skeptic Review** sends the latest task context to every configured reviewer; they run independently and in parallel, and the original task receives their conclusions and writes one digest. It runs on **stock, released Paseo** — no patched build, no forked app.

It does **not** bypass limits or share accounts. Every fallback uses its own official CLI, login, permissions, subscription, and quota.

## Settings inside Paseo, not a config file

Fleet Supervisor's settings are a Paseo surface, opened from Paseo's sidebar. It
asks Paseo for each provider's current model catalog and lets you choose an exact
model, priority, model-specific role, review lens, and continuation policy —
every key the guard reads. Changes save straight to disk and the running guard
picks them up, so nothing has to be reinstalled to change a setting. Model fields
remain editable when a CLI cannot publish a catalog.

<p align="center">
  <img src="docs/assets/provider-setup.png" width="860" alt="Fleet Guard provider setup screen">
</p>

<p align="center">
  <img src="docs/assets/fallback-order.png" width="860" alt="Fleet Guard fallback order and continuation policy screen">
</p>

## What it can do

- Continue a quota-blocked Claude task with OpenAI Codex, a local model, Google Antigravity, Cursor Agent, or GitHub Copilot CLI.
- Route Fable's separate weekly allowance to another selected Claude model before leaving Anthropic, or skip that step and move directly to another provider/model.
- Select exact models instead of only choosing a provider family.
- Give every automatic-handoff model a built-in role—progress reporting, bug checking, QA, or skepticism—or a custom highest-priority system prompt.
- Configure an independent Skeptic Review roster and review lens for each exact model; review prompts never inherit automatic-handoff instructions.
- Review the latest task context with **Skeptic Review**, from the Fleet Supervisor panel in any agent or from the command center.
- Turn automatic handoff on and off from the **Fleet Supervisor** button, which shows its own state: green while watching, red and muted when off.
- Hand the current task to the fleet yourself with the **Hand off** button, without waiting for a quota limit.
- Edit every setting inside Paseo — general switches, continuation policy, fallback order, reviewers, and the local model — on the Fleet Supervisor plugin surface. The installer never needs reopening.
- Keep Codex, local-model, Cursor, and Copilot handoffs visible as child tasks in the same Paseo workspace.
- Prioritize providers in any order.
- Nudge the same unfinished child agent instead of constantly creating replacements.
- Challenge a completion claim once by checking the workspace, diff, and tests.
- Reuse child sessions on later cycles so their conversational context survives.
- Return to the original Claude task after a configurable cooldown.
- Resume a recent interrupted continuation chain after Paseo is reopened.
- Start automatically with Paseo. The plugin launches the guard, so there is no separate launcher, shortcut, or console command to run.
- Exit completely when Paseo's daemon is gone. There is no Windows-login service or permanent watchdog.

## Getting started

1. Install the Fleet Supervisor plugin and guard with the cross-platform setup script:

   ```bash
   node payload/setup.mjs
   ```

2. Finish any requested provider CLI sign-ins.
3. Start Paseo. The plugin starts Fleet Supervisor itself — there is no separate launcher or console command.
4. Open **Fleet Supervisor** from Paseo's sidebar to set your fallback order, reviewers, and continuation policy.

### Requires Paseo 0.5.0 or newer

Everything here is a plain Paseo plugin, so a normal installed Paseo from the
[official releases](https://github.com/getpaseo/paseo/releases) is all you need.

Paseo's plugin system shipped in **v0.5.0**. On an older Paseo the guard's
automatic handoff still works — it talks to the daemon's normal API — but the
buttons and the settings surface will not appear, because there is nothing to
contribute them to. Worse, a pre-0.5.0 Paseo **refuses to start** if its config
carries the `plugins` keys, since it rejects unknown config keys.

Earlier versions of Fleet Supervisor required a Paseo built from a patch, because
0.4.0 had no plugin system at all. That is no longer true and the patch is gone.

### Requirements

- Windows 10 or Windows 11
- Paseo Desktop
- Node.js 22 or newer
- Claude Code, installed and signed in
- At least one fallback provider you can use

## Use a model running on your PC

Choose **Local model** on the provider page to add an Ollama, LM Studio, llama.cpp, or other OpenAI-compatible server running on the same computer.

1. Install [OpenCode](https://opencode.ai/docs/) so the model has a real coding-agent harness.
2. Start the local model server. Ollama's default endpoint is `http://127.0.0.1:11434/v1`.
3. Click **Configure**, then **Find models**.
4. Choose one of the models returned by the server and place **Local model** anywhere in the fallback order.

Fleet Guard creates a separate OpenCode profile for local handoffs. It gives that profile read, edit, and shell tools in the shared workspace without changing the user's normal OpenCode configuration. The endpoint is restricted to the same PC, and Fleet Guard does not request or store a local API key.

Coding agents need reliable tool calling and a useful context window. If a model struggles to use tools, try a coding-oriented model and raise its context to roughly 16k–32k before judging the loop.

## How it continues a job

With the recommended policy, the flow is:

```text
Claude reaches a confirmed session limit
  → try providers in your chosen priority order
  → nudge unfinished agents and audit completion claims
  → wait for the configured cooldown
  → retry the original Claude task
  → if Claude is still limited, reuse the fallback sessions and repeat
```

A genuine request for human input remains a hard stop. A second, audited completion verdict also stops the chain—otherwise an automatic loop would never know when the work was actually done.

Fully quitting Paseo, including its daemon, stops Fleet Guard. Reopening Paseo starts it again and can resume a recent interrupted chain.

## Exact models and model-specific roles

Each fallback card contains an editable model picker populated through Paseo's provider model API. A **Use for** switch can add one highest-priority instruction to every handoff created for that exact model. Built-in roles are deliberately narrow; a custom prompt is preserved verbatim and remains subordinate only to Fleet Supervisor's safety and completion contract.

When the watched source is Fable, the optional **Next Claude model** node can route a Fable allowance stop to another Anthropic model before the cross-provider list begins. For other Claude source models, setup explains that there is no separate Fable-style weekly allowance; normal account, session, and provider limits can still move the chain forward.

## Skeptic Review inside Paseo

Reviewers are configured separately from fallback behavior, under **Skeptic
Review** on the settings surface. Enabling a model as a reviewer reveals a
review-only lens: strengths and weaknesses, bug checking, QA, progress audit, or
a custom review prompt.

> **Leaving the reviewer list empty does not mean "no reviewers."** Fleet
> Supervisor then borrows the first three usable entries from your fallback
> order. The settings surface names them so this is visible, flags any provider
> Paseo does not have installed, and offers a one-click way to make the
> inherited list explicit and editable.

- **Skeptic Review** sends the latest projected task context to every selected reviewer. Run it from the Fleet Supervisor panel inside an agent, or from the command center (**Ctrl+K** / **⌘K**).
- Reviewers are created as parallel child tasks with review-only instructions and a structured response contract.
- Results return to the original task, which reconciles agreement and disagreement into one user-facing digest.

The local bridge between the Paseo plugin and Fleet Supervisor listens only on `127.0.0.1`, requires a random private bearer token, rejects requests over 2 MB, and never exposes provider credentials.

## Antigravity (Gemini)

Paseo drives external agents over the Agent Client Protocol, and Antigravity's
`agy` CLI has no ACP mode, so Paseo could not address it at all — an
`antigravity` fallback entry was silently dead and offered no model list.

`payload/src/antigravity-acp.mjs` bridges that gap: it speaks ACP to Paseo and
drives `agy --print --output-format stream-json` underneath, advertising the
real Gemini catalogue so the model picker works.

> **Verified.** A real Gemini turn round-trips through ACP, and the provider
> reports `ready` with 14 Gemini models inside Paseo. One limitation is the
> CLI's own: `agy` emits text only in its final result, so replies arrive in a
> single chunk rather than streaming.

Full detail: [docs/antigravity-acp.md](docs/antigravity-acp.md).

## Privacy and permissions

Provider checks stay on the local computer. Fleet Guard does not read, copy, transmit, or store provider credentials. The optional **Verify** button sends one short, no-tools request to the selected provider and may use a small amount of its quota.

Fleet-created Cursor tasks use an unattended provider profile. Codex uses auto-review, Copilot uses allow-all, and Antigravity uses its non-interactive permission mode. Those settings apply only to fallback tasks created by Fleet Guard. Council reviewers are explicitly told not to continue the task or edit the workspace.

## Status, settings, and removal

- Open **Fleet Guard Settings** from the Start Menu to change providers, priority, nudges, cooldown, or continuation behavior.
- Run `STATUS.cmd` from the installation folder to see the current policy, latest chain, next retry, and recent log entries.
- Run `UNINSTALL.cmd` to stop Fleet Guard and remove its shortcuts and Fleet-only Cursor/local-model profiles. Logs and configuration remain available for recovery.

## Build and test from source

The continuation engine and the ACP adapter use Node.js 22+. What ships is a
plugin directory, a Node script, and a cross-platform setup script — there is no
native compilation step, and the legacy C# launcher and setup app under
`desktop/` are no longer part of the install path.

```bash
npm ci --prefix payload
npm test --prefix payload
node payload/setup.mjs
```

Everything ships as a Paseo plugin, so there is nothing to compile and no
patched Paseo to build. Install a normal Paseo 0.5.0+ and run the setup script.

Two checks worth running after a change:

```bash
node payload/tests/plugin-contributions.test.mjs   # what the client bundle registers
node payload/tests/antigravity-acp.turn.mjs        # a real Gemini turn via ACP
```

The first one matters more than it looks. `paseo plugin ls` only proves the
*server* bundle loaded; the buttons live in the client bundle, which the daemon
never evaluates. That test compiles the client bundle the way Paseo does, runs
it against a mock host, and asserts on the contributions it registers — so a
plugin cannot sit at `running` with a broken UI.

To iterate on the plugin itself:

```bash
paseo plugin reload fleet-supervisor
paseo plugin logs fleet-supervisor
```

Reload picks up source edits. Do not restart the daemon for that — it can kill
a running agent.

## License

Fleet Guard is available under the [MIT License](LICENSE). It is an independent community utility and is not affiliated with Anthropic, OpenAI, Google, Cursor, GitHub, or Paseo.
