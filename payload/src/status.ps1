$guardHome = if ($env:FLEET_GUARD_STATE_HOME) { $env:FLEET_GUARD_STATE_HOME } else { Join-Path $env:USERPROFILE '.paseo-fleet-guard' }
$pidFile = Join-Path $guardHome 'guard.pid'
$configFile = Join-Path $guardHome 'config.json'
$stateFile = Join-Path $guardHome 'handled-failures.json'
$logFile = Join-Path $guardHome 'guard.log'

Write-Host ''
Write-Host 'Fleet Guard status' -ForegroundColor Cyan
Write-Host '------------------'

$running = $false
if (Test-Path -LiteralPath $pidFile) {
    $guardPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$guardPid)) {
        $running = $null -ne (Get-Process -Id $guardPid -ErrorAction SilentlyContinue)
    }
}
Write-Host ('Guard: ' + $(if ($running) { 'running invisibly with Paseo' } else { 'not running' }))

if (Test-Path -LiteralPath $configFile) {
    try {
        $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
        $policy = $config.continuationPolicy
        $mode = switch ([string]$policy.mode) {
            'return-to-source' { 'Return to Claude' }
            'cycle' { 'Cycle fallback providers' }
            default { 'One pass, then stop' }
        }
        Write-Host ('Policy: ' + $mode)
        if ($config.fallbackOrder) { Write-Host ('Fallback order: ' + (($config.fallbackOrder | ForEach-Object { [string]$_.id }) -join ' -> ')) }
        Write-Host ('Same-agent nudges: ' + [int]$policy.sameAgentNudges)
        if ($config.localModel -and $config.localModel.model) {
            Write-Host ('Local model: ' + [string]$config.localModel.model + ' at ' + [string]$config.localModel.endpoint)
        }
        if ($policy.mode -ne 'single-pass') {
            Write-Host ('Cooldown: ' + [int]$policy.retryDelayMinutes + ' minute(s)')
            Write-Host ('Reuse child sessions: ' + $(if ($policy.reuseSessions) { 'yes' } else { 'no' }))
        }
    } catch {
        Write-Host 'Policy: configuration could not be read'
    }
}

if (Test-Path -LiteralPath $stateFile) {
    try {
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        $latest = $state.handled.PSObject.Properties.Value |
            Sort-Object { if ($_.updatedAt) { $_.updatedAt } elseif ($_.finishedAt) { $_.finishedAt } else { $_.handledAt } } -Descending |
            Select-Object -First 1
        if ($latest) {
            Write-Host ('Latest chain: ' + [string]$latest.status)
            if ($latest.chain) {
                Write-Host ('Cycle: ' + ([int]$latest.chain.cycle + 1))
                if ($latest.chain.previousProvider) { Write-Host ('Last provider: ' + [string]$latest.chain.previousProvider) }
                if ($latest.chain.nextAttemptAt) { Write-Host ('Next retry: ' + ([datetime]$latest.chain.nextAttemptAt).ToLocalTime().ToString('g')) }
            }
        }
    } catch {
        Write-Host 'Latest chain: state could not be read'
    }
}

Write-Host ''
Write-Host 'Recent activity' -ForegroundColor Cyan
Write-Host '---------------'
if (Test-Path -LiteralPath $logFile) {
    Get-Content -LiteralPath $logFile -Tail 40
} else {
    Write-Host 'No Fleet Guard activity has been recorded yet.'
}
