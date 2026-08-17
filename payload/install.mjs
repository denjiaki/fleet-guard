import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeExe = process.execPath;
const guardScript = path.join(here, "src", "fleet-guard.mjs");
const launcherPs1 = path.join(here, "launch-paseo-with-guard.ps1");
const nativeLauncher = path.join(here, "FleetGuardLauncher.exe");
const settingsExe = path.join(here, "FleetGuardSetup.exe");
const launcherConfigPath = path.join(here, "launcher-config.json");
const supervisorPluginPath = path.join(here, "fleet-supervisor-plugin");

const userHome = process.env.FLEET_GUARD_USER_HOME || os.homedir();
const guardHome = process.env.FLEET_GUARD_STATE_HOME || path.join(userHome, ".paseo-fleet-guard");
const configPath = path.join(guardHome, "config.json");
const pidPath = path.join(guardHome, "guard.pid");
const paseoHome = process.env.PASEO_HOME || path.join(userHome, ".paseo");
const paseoConfig = path.join(paseoHome, "config.json");
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const startupDir = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
function windowsFolder(name, fallback) {
  try {
    const value = execFileSync("powershell.exe", ["-NoProfile", "-Command", `[Environment]::GetFolderPath('${name}')`], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}
const desktop = process.env.FLEET_GUARD_DESKTOP || windowsFolder("Desktop", path.join(userHome, "Desktop"));
const startMenuPrograms = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
const launchShortcutName = "Fleet Supervisor - On Paseo.lnk";
const desktopLink = path.join(desktop, launchShortcutName);
const startLink = path.join(startMenuPrograms, launchShortcutName);
const settingsLink = path.join(startMenuPrograms, "Fleet Guard Settings.lnk");

const defaultConfig = {
  enabled: true,
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
  council: {
    enabled: true,
    members: [],
    maxContextCharacters: 32000,
  },
  fallbackOrder: [
    { id: "codex", kind: "paseo", provider: "codex", modeId: "auto-review" },
    { id: "antigravity", kind: "antigravity" },
    { id: "cursor", kind: "paseo", provider: "fleet-cursor", modeId: "agent" },
    { id: "copilot", kind: "paseo", provider: "copilot", modeId: "allow-all" },
  ],
};

function normalizeLoopbackEndpoint(value) {
  const url = new URL(String(value || ""));
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
  if (!loopback || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Fleet local models must use an HTTP endpoint on localhost or 127.0.0.1.");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname) pathname = "/v1";
  return `${url.protocol}//${url.host}${pathname}`;
}

fs.mkdirSync(guardHome, { recursive: true });
fs.mkdirSync(desktop, { recursive: true });
fs.mkdirSync(startMenuPrograms, { recursive: true });
if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n", "utf8");

function stopExistingGuard() {
  if (!fs.existsSync(pidPath)) return;
  const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
  if (Number.isFinite(pid) && pid > 0) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      console.log(`Stopped old Fleet Guard process ${pid}.`);
    } catch {}
  }
  try { fs.unlinkSync(pidPath); } catch {}
}

stopExistingGuard();

for (const oldLink of [
  desktopLink,
  startLink,
  path.join(desktop, "Paseo + Fleet Guard.lnk"),
  path.join(startMenuPrograms, "Paseo + Fleet Guard.lnk"),
]) {
  try { fs.unlinkSync(oldLink); } catch {}
}

for (const obsolete of [
  path.join(startupDir, "Paseo Fleet Guard.vbs"),
  path.join(here, "launch-paseo-with-guard.vbs"),
]) {
  try {
    if (fs.existsSync(obsolete)) {
      fs.unlinkSync(obsolete);
      console.log(`Removed obsolete ${path.basename(obsolete)}.`);
    }
  } catch {}
}

try {
    const paseoConfigExists = fs.existsSync(paseoConfig);
    const parsed = paseoConfigExists ? JSON.parse(fs.readFileSync(paseoConfig, "utf8")) : {};
    let configChanged = false;
    if (parsed?.agents?.providers?.["fleet-supervisor"]) {
      fs.copyFileSync(paseoConfig, paseoConfig + ".before-fleet-guard-v3.0");
      delete parsed.agents.providers["fleet-supervisor"];
      configChanged = true;
      console.log("Removed obsolete visible Fleet Supervisor provider from Paseo config.");
    }
    const guardConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed.pluginsEnabled !== true) {
      parsed.pluginsEnabled = true;
      configChanged = true;
    }
    parsed.plugins ??= {};
    const desiredFleetSupervisorPlugin = {
      source: "directory",
      path: supervisorPluginPath,
      enabled: true,
    };
    if (JSON.stringify(parsed.plugins["fleet-supervisor"]) !== JSON.stringify(desiredFleetSupervisorPlugin)) {
      parsed.plugins["fleet-supervisor"] = desiredFleetSupervisorPlugin;
      configChanged = true;
      console.log("Enabled the Fleet Supervisor controls inside Paseo.");
    }
    const needsFleetCursor = guardConfig?.fallbackOrder?.some((worker) => worker?.provider === "fleet-cursor");
    if (needsFleetCursor) {
      parsed.agents ??= {};
      parsed.agents.providers ??= {};
      const desiredFleetCursor = {
        extends: "acp",
        label: "Fleet Cursor",
        description: "Cursor Agent reserved for unattended Fleet Guard handoffs",
        command: ["agent", "--yolo", "--trust", "--approve-mcps", "acp"],
        env: {},
      };
      if (JSON.stringify(parsed.agents.providers["fleet-cursor"]) !== JSON.stringify(desiredFleetCursor)) {
        parsed.agents.providers["fleet-cursor"] = desiredFleetCursor;
        configChanged = true;
        console.log("Configured the Fleet-only Cursor provider with unattended permissions.");
      }
    }
    const localWorker = guardConfig?.fallbackOrder?.find((worker) => worker?.id === "local" || String(worker?.provider || "").startsWith("fleet-local/"));
    const localSettings = guardConfig?.localModel;
    const localConfigPath = path.join(here, "opencode-fleet-local.json");
    if (localWorker && localSettings?.model && localSettings?.endpoint) {
      const endpoint = normalizeLoopbackEndpoint(localSettings.endpoint);
      const model = String(localSettings.model).trim();
      const modelId = `fleet-local-api/${model}`;
      const openCodeConfig = {
        $schema: "https://opencode.ai/config.json",
        model: modelId,
        provider: {
          "fleet-local-api": {
            npm: "@ai-sdk/openai-compatible",
            name: "Fleet Local (same PC)",
            options: { baseURL: endpoint },
            models: { [model]: { name: `${model} (Local)` } },
          },
        },
        permission: "allow",
      };
      fs.writeFileSync(localConfigPath, JSON.stringify(openCodeConfig, null, 2) + "\n", "utf8");
      parsed.agents ??= {};
      parsed.agents.providers ??= {};
      const desiredFleetLocal = {
        extends: "opencode",
        label: "Fleet Local Model",
        description: "Same-PC OpenAI-compatible model reserved for Fleet Guard handoffs",
        env: { OPENCODE_CONFIG: localConfigPath },
        models: [{ id: modelId, label: `${model} (Local)`, isDefault: true }],
      };
      if (JSON.stringify(parsed.agents.providers["fleet-local"]) !== JSON.stringify(desiredFleetLocal)) {
        parsed.agents.providers["fleet-local"] = desiredFleetLocal;
        configChanged = true;
        console.log(`Configured local model ${model} through OpenCode at ${endpoint}.`);
      }
    } else {
      if (parsed?.agents?.providers?.["fleet-local"]) {
        delete parsed.agents.providers["fleet-local"];
        configChanged = true;
      }
      try { fs.unlinkSync(localConfigPath); } catch {}
    }
    if (configChanged) {
      fs.mkdirSync(path.dirname(paseoConfig), { recursive: true });
      const backup = paseoConfig + ".before-fleet-guard-v3.0.2";
      if (paseoConfigExists && !fs.existsSync(backup)) fs.copyFileSync(paseoConfig, backup);
      fs.writeFileSync(paseoConfig, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    }
} catch (error) {
  console.warn(`Could not inspect Paseo config: ${error.message}`);
}

const findPaseo = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ -and (Test-Path $_) }
$ws = New-Object -ComObject WScript.Shell
$candidates = foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match '^Paseo$|Paseo' -and $_.BaseName -notmatch 'Fleet Guard|Fleet Supervisor' } |
    ForEach-Object {
      $shortcut = $ws.CreateShortcut($_.FullName)
      if ($shortcut.TargetPath) {
        [PSCustomObject]@{
          Target = $shortcut.TargetPath
          Arguments = $shortcut.Arguments
          IconLocation = $shortcut.IconLocation
        }
      }
    }
}
$candidates | Where-Object { $_.Target -and (Test-Path $_.Target) } | Select-Object -First 1 | ConvertTo-Json -Compress
`;

let paseo = null;
try {
  const output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", findPaseo], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (output) paseo = JSON.parse(output);
} catch {}

if (!paseo?.Target) {
  const guesses = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Paseo", "Paseo.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Paseo", "Paseo.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Paseo", "Paseo.exe"),
  ].filter(Boolean);
  const found = guesses.find((candidate) => fs.existsSync(candidate));
  if (found) paseo = { Target: found, Arguments: "", IconLocation: found };
}

if (!paseo?.Target) {
  console.error("Could not locate the Paseo desktop app. No shortcut was installed.");
  process.exit(2);
}

const launcherConfig = {
  nodeExe,
  guardScript,
  paseoTarget: paseo.Target,
  paseoArgs: paseo.Arguments || "",
  iconLocation: paseo.IconLocation && !String(paseo.IconLocation).startsWith(",")
    ? paseo.IconLocation
    : paseo.Target,
};
fs.writeFileSync(launcherConfigPath, JSON.stringify(launcherConfig, null, 2) + "\n", "utf8");

function psLiteral(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function createShortcut(linkPath) {
  const useNativeLauncher = fs.existsSync(nativeLauncher);
  const shortcutTarget = useNativeLauncher
    ? nativeLauncher
    : path.join(process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const shortcutArguments = useNativeLauncher
    ? ""
    : `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcherPs1}"`;
  const fleetIconLocation = fs.existsSync(nativeLauncher)
    ? `${nativeLauncher},0`
    : fs.existsSync(settingsExe)
      ? `${settingsExe},0`
      : launcherConfig.iconLocation;
  const script = `
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut(${psLiteral(linkPath)})
$shortcut.TargetPath = ${psLiteral(shortcutTarget)}
$shortcut.Arguments = ${psLiteral(shortcutArguments)}
$shortcut.WorkingDirectory = ${psLiteral(here)}
$shortcut.Description = 'Launch Paseo with Fleet Guard scoped to this Paseo session'
$shortcut.IconLocation = ${psLiteral(fleetIconLocation)}
$shortcut.Save()
`;
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function createSettingsShortcut() {
  if (!fs.existsSync(settingsExe)) return;
  const script = `
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut(${psLiteral(settingsLink)})
$shortcut.TargetPath = ${psLiteral(settingsExe)}
$shortcut.WorkingDirectory = ${psLiteral(here)}
$shortcut.Description = 'Change Fleet Guard providers, priority, and continuation policy'
$shortcut.IconLocation = ${psLiteral(settingsExe + ",0")}
$shortcut.Save()
`;
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
  });
}

createShortcut(desktopLink);
createShortcut(startLink);
createSettingsShortcut();

if (process.env.FLEET_GUARD_SKIP_START !== "1") {
  const guard = fs.existsSync(nativeLauncher)
    ? spawn(nativeLauncher, ["--guard-only"], { detached: true, stdio: "ignore", windowsHide: true, cwd: here })
    : spawn(nodeExe, [guardScript], { detached: true, stdio: "ignore", windowsHide: true, cwd: here });
  guard.unref();
}

console.log("");
console.log("Fleet Supervisor v4.0.0 beta 1 installed and started for the current Paseo session.");
console.log(`Detected Paseo target: ${paseo.Target}`);
console.log(`Desktop shortcut:    ${desktopLink}`);
console.log(`Start Menu shortcut: ${startLink}`);
if (fs.existsSync(settingsExe)) console.log(`Settings shortcut:   ${settingsLink}`);
console.log("There is no Windows-login hook and no VBScript launcher.");
