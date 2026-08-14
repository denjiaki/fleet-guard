FLEET GUARD — FRIENDLY SETUP v3.2.0 BETA (WINDOWS)
======================================

1. If you downloaded the standalone FleetGuardSetup.exe, simply double-click it. Nothing needs to sit beside it.
2. If you downloaded the ZIP, extract it first, then double-click FleetGuardSetup.exe.
3. Follow the provider cards. Every Get button opens that provider's official website.
4. Finish any sign-ins. Setup detects them automatically; use Verify for optional live proof.
5. Choose provider priority and a continuation policy: one pass, provider cycles, or return to Claude.
6. From then on, open the new “Fleet Supervisor - On Paseo” shortcut.

Windows may show an “Unknown publisher” warning because this community build is not code-signed. The full C# and JavaScript source is included in the source folder for review.

WHAT SETUP CHANGES
------------------

• Installs Fleet Guard for the current user at %LOCALAPPDATA%\PaseoFleetGuard
• Stores its configuration and logs at %USERPROFILE%\.paseo-fleet-guard
• Creates “Fleet Supervisor - On Paseo” shortcuts on the Desktop and Start Menu
• Gives the setup, launcher, and shortcuts a dedicated Fleet icon
• Can use a same-PC Ollama, LM Studio, llama.cpp, or compatible model through a Fleet-only OpenCode profile
• Creates a Start Menu “Fleet Guard Settings” shortcut for changing priority and continuation later
• Uses a native windowless launcher, so Fleet Guard never appears in Alt+Tab or on the taskbar
• Does not create a Windows-login task, service, scheduled task, or startup entry
• Does not collect, copy, or store provider credentials

Fleet Guard runs only alongside Paseo. It exits after Paseo's daemon has been unavailable for 20 seconds.

Persistent continuation is optional and Paseo-scoped. It can nudge the same child agent, challenge a completion claim, reuse that child on later cycles, and retry the original Claude task after a configurable cooldown. Fully quitting Paseo stops the loop.

Codex, Cursor, and Copilot handoffs appear as child tasks in Paseo. Antigravity runs as an external CLI worker, so its progress appears in STATUS.cmd and the handoff report instead of a Paseo tab.

Setup detects Antigravity and Copilot sign-in entries without reading their secrets. The optional Verify button sends one short no-tools request and uses provider quota; Antigravity may count a large fixed input context.

REQUIREMENTS
------------

• Windows 10 or 11
• Paseo Desktop
• Node.js 22 or later
• Claude Code, installed and signed in
• At least one fallback: Codex, a local model through OpenCode, Antigravity, Cursor Agent, or GitHub Copilot CLI

Fleet Guard does not bypass provider limits. Each fallback uses its own official CLI, account, policy, subscription, permissions, and quota.

If Paseo was already running during installation, fully quit Paseo once (including its daemon), then reopen it with the combined shortcut so the Fleet-only Cursor provider loads.

After installation, open “Usage Guide.html” in %LOCALAPPDATA%\PaseoFleetGuard for the everyday workflow, halted-job instructions, status, and removal steps.

Fleet Guard is an independent community utility and is not affiliated with Anthropic, OpenAI, Google, Cursor, GitHub, or Paseo.
