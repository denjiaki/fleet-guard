import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const userHome = process.env.FLEET_GUARD_USER_HOME || os.homedir();
const home = process.env.FLEET_GUARD_STATE_HOME || path.join(userHome, ".paseo-fleet-guard");
const pidPath = path.join(home, "guard.pid");
const paseoHome = process.env.PASEO_HOME || path.join(userHome, ".paseo");
const paseoConfig = path.join(paseoHome, "config.json");
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
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
const start = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
const startup = path.join(start, "Startup");

if (fs.existsSync(pidPath)) {
  const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
  if (Number.isFinite(pid) && pid > 0) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  }
}
for (const p of [
  path.join(desktop, "Fleet Supervisor - On Paseo.lnk"),
  path.join(start, "Fleet Supervisor - On Paseo.lnk"),
  path.join(desktop, "Paseo + Fleet Guard.lnk"),
  path.join(start, "Paseo + Fleet Guard.lnk"),
  path.join(start, "Fleet Guard Settings.lnk"),
  path.join(startup, "Paseo Fleet Guard.vbs")
]) {
  try { fs.unlinkSync(p); } catch {}
}
try { fs.unlinkSync(pidPath); } catch {}

if (fs.existsSync(paseoConfig)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paseoConfig, "utf8"));
    const hasFleetCursor = Boolean(parsed?.agents?.providers?.["fleet-cursor"]);
    const hasFleetLocal = Boolean(parsed?.agents?.providers?.["fleet-local"]);
    const hasFleetSupervisorPlugin = Boolean(parsed?.plugins?.["fleet-supervisor"]);
    if (hasFleetCursor || hasFleetLocal || hasFleetSupervisorPlugin) {
      const backup = paseoConfig + ".before-fleet-guard-uninstall";
      if (!fs.existsSync(backup)) fs.copyFileSync(paseoConfig, backup);
      if (hasFleetCursor) delete parsed.agents.providers["fleet-cursor"];
      if (hasFleetLocal) delete parsed.agents.providers["fleet-local"];
      if (hasFleetSupervisorPlugin) delete parsed.plugins["fleet-supervisor"];
      fs.writeFileSync(paseoConfig, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      console.log("Removed Fleet Guard's Paseo controls and Fleet-only provider profiles.");
    }
  } catch (error) {
    console.warn(`Could not remove the Fleet-only Cursor provider: ${error.message}`);
  }
}
try { fs.unlinkSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "opencode-fleet-local.json")); } catch {}

console.log("Fleet Guard stopped.");
console.log("Combined Paseo shortcuts and any legacy startup hook were removed.");
console.log(`Logs/config were left at: ${home}`);
