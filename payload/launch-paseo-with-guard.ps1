$ErrorActionPreference = 'Stop'
$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -Raw -LiteralPath (Join-Path $baseDir 'launcher-config.json') | ConvertFrom-Json
$guardHome = Join-Path $env:USERPROFILE '.paseo-fleet-guard'
$pidFile = Join-Path $guardHome 'guard.pid'
$guardRunning = $false

if (Test-Path -LiteralPath $pidFile) {
    $guardPid = Get-Content -Raw -LiteralPath $pidFile
    if ($guardPid -match '^\d+$') {
        $guardRunning = $null -ne (Get-Process -Id ([int]$guardPid) -ErrorAction SilentlyContinue)
    }
}

if (-not $guardRunning) {
    Start-Process -FilePath $config.nodeExe -ArgumentList @($config.guardScript) -WorkingDirectory $baseDir -WindowStyle Hidden
}

if ([string]::IsNullOrWhiteSpace([string]$config.paseoArgs)) {
    Start-Process -FilePath $config.paseoTarget
} else {
    Start-Process -FilePath $config.paseoTarget -ArgumentList ([string]$config.paseoArgs)
}
