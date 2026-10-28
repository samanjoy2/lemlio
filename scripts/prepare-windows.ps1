$ErrorActionPreference = 'Stop'
$prismRoot = Split-Path $PSScriptRoot -Parent
$resourceDir = Join-Path $prismRoot 'apps\desktop\src-tauri\resources\tectonic'
New-Item -ItemType Directory -Force $resourceDir | Out-Null
$archive = Join-Path $resourceDir 'tectonic.zip'
if (!(Test-Path (Join-Path $resourceDir 'tectonic.exe'))) {
    Write-Host 'Downloading the official Tectonic Windows binary...'
    Invoke-WebRequest 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip' -OutFile $archive
    $expectedHash = 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f'
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw 'Tectonic checksum did not match the official release.'
    }
    Expand-Archive $archive -DestinationPath $resourceDir -Force
    Remove-Item -LiteralPath $archive
}
Write-Host 'Tectonic is ready.'
