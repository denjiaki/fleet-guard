$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Split-Path -Parent $root
$out = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
$framework = 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.5.2'
$reference = {
    param([string]$name)
    '/reference:' + (Join-Path $framework $name)
}
$icon = Join-Path $root 'FleetGuard.ico'
$iconGenerator = Join-Path $out 'GenerateFleetIcon.exe'
$iconArguments = @(
    '/nologo',
    '/target:exe',
    '/optimize+',
    ('/out:' + $iconGenerator),
    (Join-Path $root 'GenerateFleetIcon.cs')
)
& $csc $iconArguments
if ($LASTEXITCODE -ne 0) { throw "Icon generator compilation failed with exit code $LASTEXITCODE" }
& $iconGenerator $icon
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $icon)) { throw 'Fleet icon generation failed.' }
Remove-Item -LiteralPath $iconGenerator -Force

$launcherArguments = @(
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:anycpu',
    ('/win32icon:' + $icon),
    ('/out:' + (Join-Path $out 'FleetGuardLauncher.exe')),
    (Join-Path $root 'FleetGuardLauncher.cs')
)
& $csc $launcherArguments
if ($LASTEXITCODE -ne 0) { throw "C# launcher compilation failed with exit code $LASTEXITCODE" }

$payloadSource = Join-Path $project 'payload'
$payloadStage = Join-Path $out 'embedded-payload'
$payloadArchive = Join-Path $out 'FleetGuardPayload.zip'
if (Test-Path -LiteralPath $payloadStage) {
    $resolvedStage = [IO.Path]::GetFullPath($payloadStage)
    $resolvedOut = [IO.Path]::GetFullPath($out) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedStage.StartsWith($resolvedOut, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to clear an embedded-payload directory outside desktop\bin.'
    }
    Remove-Item -LiteralPath $payloadStage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $payloadStage | Out-Null
Get-ChildItem -LiteralPath $payloadSource -Force |
    Where-Object { $_.Name -notin @('node_modules', 'launcher-config.json') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $payloadStage -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $out 'FleetGuardLauncher.exe') -Destination $payloadStage -Force
if (Test-Path -LiteralPath $payloadArchive) { Remove-Item -LiteralPath $payloadArchive -Force }
Compress-Archive -Path (Join-Path $payloadStage '*') -DestinationPath $payloadArchive -CompressionLevel Optimal

$arguments = @(
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:anycpu',
    ('/win32icon:' + $icon),
    ('/resource:' + $payloadArchive + ',FleetGuardPayload.zip'),
    ('/out:' + (Join-Path $out 'FleetGuardSetup.exe')),
    (& $reference 'PresentationFramework.dll'),
    (& $reference 'PresentationCore.dll'),
    (& $reference 'WindowsBase.dll'),
    (& $reference 'System.Xaml.dll'),
    (& $reference 'System.IO.Compression.dll'),
    (& $reference 'System.IO.Compression.FileSystem.dll'),
    (Join-Path $root 'FleetGuardSetup.cs')
)
& $csc $arguments
if ($LASTEXITCODE -ne 0) { throw "C# setup compilation failed with exit code $LASTEXITCODE" }

$resolvedStage = [IO.Path]::GetFullPath($payloadStage)
$resolvedOut = [IO.Path]::GetFullPath($out) + [IO.Path]::DirectorySeparatorChar
if ($resolvedStage.StartsWith($resolvedOut, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $payloadStage -Recurse -Force
}
Write-Host "Built standalone $out\FleetGuardSetup.exe and FleetGuardLauncher.exe"
