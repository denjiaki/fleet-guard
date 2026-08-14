$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspace = Split-Path -Parent (Split-Path -Parent $project)
$releaseRoot = Join-Path $project 'release'
$releaseName = 'Fleet Guard Friendly Setup v3.2.0 beta'
$releaseDir = Join-Path $releaseRoot $releaseName
$zipPath = Join-Path $releaseRoot ($releaseName + '.zip')

& (Join-Path $project 'desktop\build.ps1')

if (Test-Path -LiteralPath $releaseDir) {
    $resolvedRelease = [IO.Path]::GetFullPath($releaseDir)
    $resolvedRoot = [IO.Path]::GetFullPath($releaseRoot) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedRelease.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to clear a release directory outside this project.'
    }
    Remove-Item -LiteralPath $releaseDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

Copy-Item -LiteralPath (Join-Path $project 'desktop\bin\FleetGuardSetup.exe') -Destination $releaseDir
Copy-Item -LiteralPath (Join-Path $project 'README-FIRST.txt') -Destination $releaseDir

$payloadOut = Join-Path $releaseDir 'payload'
New-Item -ItemType Directory -Force -Path $payloadOut | Out-Null
Get-ChildItem -LiteralPath (Join-Path $project 'payload') -Force |
    Where-Object { $_.Name -notin @('node_modules', 'launcher-config.json') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $payloadOut -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $project 'desktop\bin\FleetGuardLauncher.exe') -Destination $payloadOut

$sourceOut = Join-Path $releaseDir 'source'
New-Item -ItemType Directory -Force -Path $sourceOut | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'desktop\FleetGuardSetup.cs') -Destination $sourceOut
Copy-Item -LiteralPath (Join-Path $project 'desktop\FleetGuardLauncher.cs') -Destination $sourceOut
Copy-Item -LiteralPath (Join-Path $project 'desktop\GenerateFleetIcon.cs') -Destination $sourceOut
Copy-Item -LiteralPath (Join-Path $project 'desktop\FleetGuard.ico') -Destination $sourceOut
Copy-Item -LiteralPath (Join-Path $project 'desktop\FleetGuard.png') -Destination $sourceOut
Copy-Item -LiteralPath (Join-Path $project 'desktop\build.ps1') -Destination $sourceOut
Copy-Item -LiteralPath (Join-Path $project 'payload\src') -Destination $sourceOut -Recurse
Copy-Item -LiteralPath (Join-Path $project 'payload\install.mjs') -Destination $sourceOut
Copy-Item -LiteralPath (Join-Path $project 'payload\uninstall.mjs') -Destination $sourceOut

$hashes = Get-ChildItem -LiteralPath $releaseDir -File -Recurse |
    Sort-Object FullName |
    ForEach-Object {
        $relative = $_.FullName.Substring($releaseDir.Length + 1)
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $relative"
    }
$hashes | Set-Content -LiteralPath (Join-Path $releaseDir 'SHA256SUMS.txt') -Encoding ascii

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -LiteralPath $releaseDir -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host $zipPath
