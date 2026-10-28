param([string]$ExecutableName = 'PrismPro.exe')
$ErrorActionPreference = 'Stop'
$prismRoot = Split-Path $PSScriptRoot -Parent
Push-Location $prismRoot
try {
    # Limit concurrent Rust compilers to keep release builds within desktop RAM.
    if (!$env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '2' }
    if (Test-Path '.tools\cargo\bin\cargo.exe') {
        $env:CARGO_HOME = Join-Path $prismRoot '.tools\cargo'
        $env:RUSTUP_HOME = Join-Path $prismRoot '.tools\rustup'
        $env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
    }
    & "$PSScriptRoot\prepare-windows.ps1"
    pnpm --config.manage-package-manager-versions=false --filter @prismpro/desktop tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw 'PrismPro build failed' }
    $portable = Join-Path $prismRoot 'dist-windows'
    New-Item -ItemType Directory -Force $portable | Out-Null
    Copy-Item -LiteralPath 'apps\desktop\src-tauri\target\release\prismpro-desktop.exe' -Destination (Join-Path $portable $ExecutableName) -Force
    New-Item -ItemType Directory -Force (Join-Path $portable 'resources') | Out-Null
    Copy-Item -LiteralPath 'apps\desktop\src-tauri\resources\tectonic' -Destination (Join-Path $portable 'resources') -Recurse -Force
    Write-Host "Ready: $portable\$ExecutableName"
} finally { Pop-Location }
