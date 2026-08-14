# Changelog

## v3.2.0 beta

- Added a genuinely standalone setup executable with its complete payload embedded.
- Added a guided same-PC local-model fallback through OpenCode.
- Added discovery for Ollama, LM Studio, llama.cpp, and other OpenAI-compatible `/v1/models` endpoints.
- Added a Fleet-only OpenCode configuration so local handoffs receive workspace tools without changing normal OpenCode settings.
- Restricted local endpoints to loopback addresses and avoided local API-key storage.
- Replaced the README screenshots with privacy-safe renders over a neutral background.
- Published the beta as a visible GitHub Release with both standalone EXE and ZIP assets.

## v3.1.1 beta

- Added a dedicated high-resolution Fleet icon to the setup app and windowless launcher.
- Applied the Fleet icon to the installed launch and settings shortcuts.
- Renamed the combined shortcut to **Fleet Supervisor - On Paseo**.
- Preserved upgrade and uninstall cleanup for the former **Paseo + Fleet Guard** shortcut.
- Added configurable continuation policies: return to Claude, cycle fallbacks, or stop after one pass.
- Added configurable same-agent nudges, cooldowns, completion audits, and child-session reuse.
- Added persistent continuation state so recent interrupted chains can resume.
- Kept the Guard Paseo-scoped and hidden from Alt+Tab and the taskbar.

## v3.0.3 beta

- Replaced the visible command window with a native windowless launcher.
- Improved provider fall-through and Antigravity handoff handling.

## v3.0 beta

- Introduced the friendly Windows setup wizard and provider verification flow.
