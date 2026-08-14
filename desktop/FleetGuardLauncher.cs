using System;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;

namespace FleetGuardLauncher
{
    internal sealed class LauncherConfig
    {
        public string nodeExe { get; set; }
        public string guardScript { get; set; }
        public string paseoTarget { get; set; }
        public string paseoArgs { get; set; }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            try
            {
                string configPath = Path.Combine(baseDir, "launcher-config.json");
                LauncherConfig config = new JavaScriptSerializer().Deserialize<LauncherConfig>(File.ReadAllText(configPath));
                if (config == null || String.IsNullOrWhiteSpace(config.nodeExe) || String.IsNullOrWhiteSpace(config.guardScript))
                    throw new InvalidOperationException("launcher-config.json is incomplete.");

                StartGuardIfNeeded(config, baseDir);
                bool guardOnly = args != null && Array.Exists(args, delegate(string value) { return String.Equals(value, "--guard-only", StringComparison.OrdinalIgnoreCase); });
                if (!guardOnly) StartPaseo(config, baseDir);
                return 0;
            }
            catch (Exception error)
            {
                WriteError(error);
                return 1;
            }
        }

        private static void StartGuardIfNeeded(LauncherConfig config, string baseDir)
        {
            string stateHome = Environment.GetEnvironmentVariable("FLEET_GUARD_STATE_HOME");
            if (String.IsNullOrWhiteSpace(stateHome))
                stateHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".paseo-fleet-guard");
            string pidFile = Path.Combine(stateHome, "guard.pid");
            if (GuardIsRunning(pidFile, config.nodeExe)) return;

            ProcessStartInfo guard = new ProcessStartInfo
            {
                FileName = config.nodeExe,
                Arguments = Quote(config.guardScript),
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(guard);
        }

        private static bool GuardIsRunning(string pidFile, string expectedNode)
        {
            try
            {
                if (!File.Exists(pidFile)) return false;
                int pid;
                if (!Int32.TryParse(File.ReadAllText(pidFile).Trim(), out pid) || pid <= 0) return false;
                using (Process process = Process.GetProcessById(pid))
                {
                    if (process.HasExited) return false;
                    try
                    {
                        string runningPath = Path.GetFullPath(process.MainModule.FileName);
                        string expectedPath = Path.GetFullPath(expectedNode);
                        return String.Equals(runningPath, expectedPath, StringComparison.OrdinalIgnoreCase);
                    }
                    catch
                    {
                        return true;
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        private static void StartPaseo(LauncherConfig config, string baseDir)
        {
            if (String.IsNullOrWhiteSpace(config.paseoTarget))
                throw new InvalidOperationException("The Paseo application path is missing.");
            ProcessStartInfo paseo = new ProcessStartInfo
            {
                FileName = config.paseoTarget,
                Arguments = config.paseoArgs ?? "",
                WorkingDirectory = baseDir,
                UseShellExecute = true
            };
            Process.Start(paseo);
        }

        private static string Quote(string value)
        {
            return "\"" + String.Concat(value ?? "").Replace("\"", "\\\"") + "\"";
        }

        private static void WriteError(Exception error)
        {
            try
            {
                string stateHome = Environment.GetEnvironmentVariable("FLEET_GUARD_STATE_HOME");
                if (String.IsNullOrWhiteSpace(stateHome))
                    stateHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".paseo-fleet-guard");
                Directory.CreateDirectory(stateHome);
                File.AppendAllText(Path.Combine(stateHome, "launcher-error.log"), DateTime.UtcNow.ToString("O") + " " + error + Environment.NewLine);
            }
            catch { }
        }
    }
}
