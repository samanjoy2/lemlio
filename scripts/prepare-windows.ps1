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

$fontDir = Join-Path $resourceDir 'fonts'
if (!(Test-Path (Join-Path $fontDir 'lmsans10-regular.otf'))) {
    Write-Host 'Preparing Latin Modern 2.005 fonts for bundled Tectonic...'
    $fontArchive = Join-Path $resourceDir 'latin-modern.zip'
    Invoke-WebRequest 'https://mirrors.ctan.org/fonts/lm.zip' -OutFile $fontArchive
    if ((Get-FileHash $fontArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '71c48809cb50fbfe09c8eddaa251398957c7b243acdf69f7f807268f0d42c939') {
        throw 'Latin Modern checksum did not match the pinned CTAN package.'
    }
    New-Item -ItemType Directory -Force $fontDir | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $fonts = [IO.Compression.ZipFile]::OpenRead($fontArchive)
    try {
        foreach ($entry in $fonts.Entries) {
            if ($entry.FullName -match '\.otf$|GUST-FONT-LICENSE.TXT$|README-Latin-Modern.TXT$|MANIFEST-Latin-Modern.TXT$') {
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $fontDir $entry.Name), $true)
            }
        }
    } finally { $fonts.Dispose() }
    Remove-Item -LiteralPath $fontArchive
}
Write-Host 'Bundled fonts are ready.'
