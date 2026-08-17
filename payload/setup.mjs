#!/usr/bin/env node
/**
 * Fleet Supervisor â€” cross-platform setup.
 *
 * Replaces the Windows-only C# setup app and launcher shortcut. There is no
 * longer anything platform-specific to install:
 *
 *   - The settings UI is a Paseo plugin surface, so Paseo renders it on
 *     Windows, macOS and Linux alike.
 *   - The guard is started by the plugin itself when Paseo's daemon loads it,
 *     so no launcher, shortcut, login item or service is needed.
 *
 * This script therefore only has to do two things: register the plugin with
 * Paseo, and tell Fleet Supervisor where its guard script lives.
 *
 * Usage:
 *   node setup.mjs                 # install
 *   node setup.mjs --uninstall     # remove the plugin registration
 *   node setup.mjs --paseo-home X  # override Paseo's home directory
 *   node setup.mjs --keep-legacy   # do not clean up an older install
 *
 * Safe to re-run: every write is idempotent and existing settings are kept.
 * Installing also removes what a pre-v4 install left behind â€” the Windows-only
 * launcher directory and its shortcuts â€” so upgrading does not leave a stale
 * shortcut pointing at a guard that no longer belongs there.
 */

import { readFile, writeFile, mkdir, access, rm, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = "fleet-supervisor";

const DEFAULT_FLEET_CONFIG = {
  enabled: true,
  autoStart: true,
  autoHandoff: true,
  daemonUrl: "ws://127.0.0.1:6767/ws",
  watchProviderPrefixes: ["claude/", "claude"],
  onlyRootClaudeAgents: true,
  recentTimelineEntries: 100,
  recentContextCharacters: 28000,
  catchUpWindowMinutes: 240,
  continuationPolicy: {
    mode: "return-to-source",
    sameAgentNudges: 1,
    verifyCompletion: true,
    reuseSessions: true,
    retryDelayMinutes: 15,
    maxCycles: 0,
  },
  council: { enabled: true, members: [], maxContextCharacters: 32000 },
  fallbackOrder: [
    { id: "codex", kind: "paseo", provider: "codex", modeId: "auto-review" },
    { id: "antigravity", kind: "antigravity" },
    { id: "cursor", kind: "paseo", provider: "fleet-cursor", modeId: "agent" },
    { id: "copilot", kind: "paseo", provider: "copilot", modeId: "allow-all" },
  ],
};

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolvePaseoHome() {
  return (
    arg("--paseo-home") ?? process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo")
  );
}

function resolveFleetHome() {
  return (
    arg("--fleet-home") ??
    process.env.FLEET_GUARD_STATE_HOME ??
    path.join(os.homedir(), ".paseo-fleet-guard")
  );
}

async function exists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ */
/* Legacy cleanup                                                      */
/* ------------------------------------------------------------------ */

/**
 * Fleet Guard v3 and earlier installed a Windows-only C# launcher into
 * `%LOCALAPPDATA%\PaseoFleetGuard` and left shortcuts behind that start it.
 * None of that is used any more â€” the plugin starts the guard itself â€” but an
 * upgrade used to leave both in place, so a stale shortcut would silently
 * launch the old guard against the new Paseo.
 *
 * Removing them is part of installing, so an upgrade cleans up after its own
 * predecessors. Pass `--keep-legacy` to leave them alone.
 */
/**
 * Matched by prefix rather than exact name. Older installs shipped several
 * shortcuts ("â€¦ - On Paseo", "Fleet Guard Settings", and others), and an exact
 * list quietly misses whichever one it does not know about â€” which is how a
 * stale "Fleet Guard Settings" shortcut survived a cleanup that removed its
 * target directory, leaving a shortcut pointing at nothing.
 */
const LEGACY_SHORTCUT_PREFIXES = ["Fleet Guard", "Fleet Supervisor", "Paseo (Fleet Supervisor)"];

function isLegacyShortcut(name) {
  if (!name.toLowerCase().endsWith(".lnk")) return false;
  return LEGACY_SHORTCUT_PREFIXES.some((prefix) =>
    name.toLowerCase().startsWith(prefix.toLowerCase()),
  );
}

function legacyShortcutDirectories() {
  if (process.platform !== "win32") return [];
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const dirs = [
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(home, "Desktop"),
  ];
  // Desktop is often redirected into OneDrive, and the shortcut follows it.
  if (process.env.OneDrive) dirs.push(path.join(process.env.OneDrive, "Desktop"));
  return dirs;
}

function legacyInstallDirectories() {
  if (process.platform !== "win32") return [];
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return [path.join(localAppData, "PaseoFleetGuard")];
}

async function removeLegacyArtifacts() {
  const removed = [];
  const failed = [];

  for (const dir of legacyShortcutDirectories()) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue; // Directory may not exist on this machine; nothing to clean.
    }
    for (const name of entries) {
      if (!isLegacyShortcut(name)) continue;
      const target = path.join(dir, name);
      try {
        await rm(target, { force: true });
        removed.push(target);
      } catch (error) {
        failed.push(`${target} (${error?.message ?? error})`);
      }
    }
  }

  for (const dir of legacyInstallDirectories()) {
    if (!(await exists(dir))) continue;
    try {
      // Settings and logs live in ~/.paseo-fleet-guard, not here, so this only
      // removes the old program files.
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (error) {
      failed.push(`${dir} (${error?.message ?? error})`);
    }
  }

  if (removed.length > 0) {
    console.log("Removed leftovers from an earlier Fleet Guard install:");
    for (const item of removed) console.log(`  - ${item}`);
  }
  if (failed.length > 0) {
    console.log("Could not remove these (close Paseo and any old launcher, then re-run):");
    for (const item of failed) console.log(`  - ${item}`);
  }
  return { removed, failed };
}

/** Resolve the plugin directory and guard script relative to this file. */
async function resolveLayout() {
  const candidates = [
    { plugin: path.join(HERE, "fleet-supervisor-plugin"), guard: path.join(HERE, "src", "fleet-guard.mjs") },
    { plugin: path.join(HERE, "fleet-supervisor-plugin"), guard: path.join(HERE, "fleet-guard.mjs") },
    { plugin: path.join(HERE, "payload", "fleet-supervisor-plugin"), guard: path.join(HERE, "payload", "src", "fleet-guard.mjs") },
  ];
  for (const candidate of candidates) {
    if ((await exists(candidate.plugin)) && (await exists(candidate.guard))) return candidate;
  }
  return null;
}

async function install() {
  const layout = await resolveLayout();
  if (!layout) {
    console.error(
      "Could not find fleet-supervisor-plugin/ and fleet-guard.mjs next to this script.",
    );
    console.error(`Looked relative to: ${HERE}`);
    process.exitCode = 1;
    return;
  }

  const paseoHome = resolvePaseoHome();
  const fleetHome = resolveFleetHome();
  const paseoConfigFile = path.join(paseoHome, "config.json");

  if (!(await exists(paseoHome))) {
    console.error(`Paseo home not found at ${paseoHome}.`);
    console.error("Start Paseo once so it creates its home, or pass --paseo-home <path>.");
    process.exitCode = 1;
    return;
  }

  // --- Paseo side: enable plugins and register this one -------------------
  const paseoConfig = await readJson(paseoConfigFile, {});
  paseoConfig.version ??= 1;
  paseoConfig.pluginsEnabled = true;
  paseoConfig.plugins = {
    ...(paseoConfig.plugins ?? {}),
    [PLUGIN_ID]: { source: "directory", path: layout.plugin, enabled: true },
  };
  await writeJson(paseoConfigFile, paseoConfig);
  console.log(`Registered the ${PLUGIN_ID} plugin in ${paseoConfigFile}`);

  // --- Fleet side: keep existing settings, fill in what is missing --------
  const existing = await readJson(path.join(fleetHome, "config.json"), null);
  const fleetConfig = {
    ...DEFAULT_FLEET_CONFIG,
    ...(existing ?? {}),
    continuationPolicy: {
      ...DEFAULT_FLEET_CONFIG.continuationPolicy,
      ...(existing?.continuationPolicy ?? {}),
    },
    council: { ...DEFAULT_FLEET_CONFIG.council, ...(existing?.council ?? {}) },
    fallbackOrder: existing?.fallbackOrder ?? DEFAULT_FLEET_CONFIG.fallbackOrder,
    // Always refreshed: the guard has to be launched from wherever this copy
    // now lives, even if the folder moved since the last install.
    guardScript: layout.guard,
  };
  await writeJson(path.join(fleetHome, "config.json"), fleetConfig);
  console.log(`Wrote Fleet Supervisor settings to ${path.join(fleetHome, "config.json")}`);
  console.log(`Guard script: ${layout.guard}`);

  // --- Upgrade hygiene: clear out anything an older install left behind ----
  if (!process.argv.includes("--keep-legacy")) await removeLegacyArtifacts();

  console.log("");
  console.log("Done. Fully quit Paseo (including its daemon) and reopen it.");
  console.log("Fleet Supervisor starts with Paseo and exits with it â€” no shortcut needed.");
  console.log("You will find its settings in Paseo's sidebar, and Skeptic Review in the composer.");
}

async function uninstall() {
  const paseoConfigFile = path.join(resolvePaseoHome(), "config.json");
  const paseoConfig = await readJson(paseoConfigFile, null);
  if (!paseoConfig?.plugins?.[PLUGIN_ID]) {
    console.log("Fleet Supervisor is not registered with Paseo; nothing to remove.");
    return;
  }
  delete paseoConfig.plugins[PLUGIN_ID];
  // Leaving `pluginsEnabled` set is harmless for a Paseo that understands it,
  // but a Paseo without a plugin system refuses to start on unknown keys â€” so
  // drop both once nothing is registered.
  if (Object.keys(paseoConfig.plugins).length === 0) {
    delete paseoConfig.plugins;
    delete paseoConfig.pluginsEnabled;
  }
  await writeJson(paseoConfigFile, paseoConfig);
  console.log(`Removed the ${PLUGIN_ID} plugin from ${paseoConfigFile}`);

  if (!process.argv.includes("--keep-legacy")) await removeLegacyArtifacts();

  console.log("Settings and logs under ~/.paseo-fleet-guard were left alone.");
  console.log("Fully quit Paseo and reopen it to finish.");
}

const mode = process.argv.includes("--uninstall") ? uninstall : install;
mode().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
