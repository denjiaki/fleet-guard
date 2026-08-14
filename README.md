<p align="center">
  <img src="docs/assets/fleet-guard.png" width="190" alt="Fleet Guard icon">
</p>

<h1 align="center">Fleet Guard</h1>

<p align="center">
  A friendly Windows companion for Paseo that keeps long-running Claude jobs moving when a session limit gets in the way.
</p>

<p align="center">
  <a href="https://github.com/denjiaki/fleet-guard/releases/download/v3.2.0-beta/FleetGuardSetup-v3.2.0-beta.exe"><strong>Download the standalone installer</strong></a>
  ·
  <a href="#getting-started">Getting started</a>
  ·
  <a href="#how-it-continues-a-job">How it works</a>
</p>

> **Beta software:** Fleet Guard is useful today, but it is still young. Keep an eye on important work and report anything surprising.

Fleet Guard watches a root Claude Code task inside [Paseo](https://paseo.sh/). When Claude reports a real session or quota limit, Fleet Guard hands the same workspace and task context to the next provider you chose—including a model running locally on your own PC. It can nudge an unfinished agent, check a premature completion claim, cycle through fallbacks, and return the work to the original Claude task after a cooldown.

It does **not** bypass limits or share accounts. Every fallback uses its own official CLI, login, permissions, subscription, and quota.

## A setup wizard instead of a config file

The Windows setup app finds the providers already available on the computer, offers friendly **Get** and **Verify** controls, and lets the user choose a priority order and continuation policy.

<p align="center">
  <img src="docs/assets/provider-setup.png" width="860" alt="Fleet Guard provider setup screen">
</p>

<p align="center">
  <img src="docs/assets/fallback-order.png" width="860" alt="Fleet Guard fallback order and continuation policy screen">
</p>

## What it can do

- Continue a quota-blocked Claude task with OpenAI Codex, a local model, Google Antigravity, Cursor Agent, or GitHub Copilot CLI.
- Keep Codex, local-model, Cursor, and Copilot handoffs visible as child tasks in the same Paseo workspace.
- Prioritize providers in any order.
- Nudge the same unfinished child agent instead of constantly creating replacements.
- Challenge a completion claim once by checking the workspace, diff, and tests.
- Reuse child sessions on later cycles so their conversational context survives.
- Return to the original Claude task after a configurable cooldown.
- Resume a recent interrupted continuation chain after Paseo is reopened.
- Stay out of Alt+Tab and the taskbar through a native windowless launcher.
- Exit completely when Paseo's daemon is gone. There is no Windows-login service or permanent watchdog.

## Getting started

1. Download the standalone [FleetGuardSetup.exe](https://github.com/denjiaki/fleet-guard/releases/download/v3.2.0-beta/FleetGuardSetup-v3.2.0-beta.exe). A traditional ZIP is available on the same release page if you prefer it.
2. Double-click the downloaded installer—there is nothing else to extract or keep beside it.
3. Follow the provider cards and finish any requested CLI sign-ins.
4. Choose your fallback priority and continuation policy.
5. From then on, start Paseo with **Fleet Supervisor - On Paseo** from the Desktop or Start Menu.

Windows may show an **Unknown publisher** warning because this community beta is not code-signed. The complete C# and JavaScript source is here for review.

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

Fully quitting Paseo, including its daemon, stops Fleet Guard. Reopening Paseo through the combined shortcut can resume a recent interrupted chain.

## Privacy and permissions

Provider checks stay on the local computer. Fleet Guard does not read, copy, transmit, or store provider credentials. The optional **Verify** button sends one short, no-tools request to the selected provider and may use a small amount of its quota.

Fleet-created Cursor tasks use an unattended provider profile. Codex uses auto-review, Copilot uses allow-all, and Antigravity uses its non-interactive permission mode. Those settings apply only to fallback tasks created by Fleet Guard.

## Status, settings, and removal

- Open **Fleet Guard Settings** from the Start Menu to change providers, priority, nudges, cooldown, or continuation behavior.
- Run `STATUS.cmd` from the installation folder to see the current policy, latest chain, next retry, and recent log entries.
- Run `UNINSTALL.cmd` to stop Fleet Guard and remove its shortcuts and Fleet-only Cursor/local-model profiles. Logs and configuration remain available for recovery.

## Build and test from source

The desktop interface and windowless launcher target .NET Framework 4.5.2. The continuation engine uses Node.js 22+. The build embeds the complete runtime payload into the setup executable, so the resulting EXE works by itself.

```powershell
npm ci --prefix payload
npm test --prefix payload
powershell -ExecutionPolicy Bypass -File .\package-release.ps1
```

The finished standalone EXE is written to `desktop/bin/`; the full ZIP is written to `release/`.

## License

Fleet Guard is available under the [MIT License](LICENSE). It is an independent community utility and is not affiliated with Anthropic, OpenAI, Google, Cursor, GitHub, or Paseo.
