param(
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [string]$ImportName = 'Prism-2026-10-28'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$prismRoot = Split-Path $PSScriptRoot -Parent
$libraryRoot = Join-Path $prismRoot 'Projects'
$destination = [IO.Path]::GetFullPath((Join-Path $libraryRoot $ImportName))
$allowedRoot = [IO.Path]::GetFullPath($libraryRoot).TrimEnd('\') + '\'
if (!$destination.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Import must stay inside the Projects folder.' }
if (Test-Path -LiteralPath $destination) { throw "Import destination already exists: $destination" }
$zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
try {
    $targets = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $entries = @($zip.Entries | Where-Object { !$_.FullName.EndsWith('/') })
    # Validate the entire archive before creating files. Never run imported scripts.
    foreach ($entry in $zip.Entries) {
        if ($entry.FullName.Contains(':') -or [IO.Path]::IsPathRooted($entry.FullName)) { throw "Unsafe ZIP path: $($entry.FullName)" }
        $target = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
        if (!$target.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "ZIP entry escapes the import folder: $($entry.FullName)" }
        if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Symbolic links are not supported in project exports.' }
        if (!$entry.FullName.EndsWith('/') -and !$targets.Add($target)) { throw "Duplicate ZIP path: $($entry.FullName)" }
    }
    New-Item -ItemType Directory -Force $destination | Out-Null
    $checksums = @()
    foreach ($entry in $entries) {
        $target = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        $hasher = [Security.Cryptography.SHA256]::Create()
        $stream = $entry.Open()
        try { $expected = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose(); $hasher.Dispose() }
        $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        if ($actual -ne $expected) { throw "Verification failed: $($entry.FullName)" }
        $checksums += [pscustomobject]@{ path=$entry.FullName; sha256=$actual; bytes=$entry.Length }
    }
    $projects = @($entries | Where-Object { $_.FullName.Contains('/') } | Group-Object { ($_.FullName -split '/')[0] } | Sort-Object Name | ForEach-Object {
        $projectName = $_.Name
        $projectFiles = @($_.Group)
        $texFiles = @($projectFiles | Where-Object { $_.FullName -match '\.(tex|ltx)$' } | ForEach-Object { $_.FullName.Substring($projectName.Length+1) })
        $mainFile = $texFiles | Where-Object { $_ -match '(^|/)(main|document)\.tex$' } | Select-Object -First 1
        if (!$mainFile) { $mainFile = $texFiles | Where-Object { $_ -match '(^|/)(acl_latex|paper|poster)\.tex$' } | Select-Object -First 1 }
        if (!$mainFile) {
            $mainFile = $texFiles | Where-Object { [IO.File]::ReadAllText((Join-Path (Join-Path $destination $projectName) $_)) -match '\\documentclass' } | Select-Object -First 1
        }
        if (!$mainFile) { $mainFile = $texFiles | Select-Object -First 1 }
        [pscustomobject]@{ name=$projectName; relativePath="$ImportName/$projectName"; mainFile=$mainFile; fileCount=$projectFiles.Count; texFileCount=$texFiles.Count; conversationCount=@($projectFiles | Where-Object { $_.FullName -match '/conversations/.*\.json$' }).Count }
    })
    $exportReportPath = Join-Path $destination 'export-errors.json'
    $exportReport = if (Test-Path -LiteralPath $exportReportPath) { Get-Content -LiteralPath $exportReportPath -Raw | ConvertFrom-Json } else { $null }
    $manifest = [pscustomobject]@{
        importedAt=[DateTime]::UtcNow.ToString('o'); archive=[IO.Path]::GetFullPath($ArchivePath)
        originalFileCount=$entries.Count; verifiedFileCount=$checksums.Count
        originalBytes=($entries | Measure-Object Length -Sum).Sum
        failedExportCount=if ($exportReport) { $exportReport.failedProjectCount } else { 0 }
        failedExports=if ($exportReport) { @($exportReport.errors | ForEach-Object { [pscustomobject]@{name=$_.projectTitle;message=$_.message} }) } else { @() }
        projects=$projects
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $libraryRoot 'library.json') -Encoding utf8
    $checksums | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $libraryRoot 'import-checksums.json') -Encoding utf8
    $report = @('# Prism project import', '', "Imported $($projects.Count) project folders and verified all $($entries.Count) original files against the ZIP using SHA-256.", '', 'The original ZIP is unchanged. All original filenames, source files, images, bibliography, and exported conversation JSON are preserved.', '', '## Export limitations', '', "$($manifest.failedExportCount) projects failed in the original Prism export and their contents are absent from the ZIP. They need a new export from the original service.", '', 'Original conversations are preserved as exported JSON. They are archives, not resumable local Codex sessions.', '', '## Projects', '')
    foreach ($project in $projects) { $report += "- $($project.name): $($project.fileCount) files; $($project.texFileCount) LaTeX files; $($project.conversationCount) conversation archives." }
    $report += @('', '## Projects missing from the original export', '')
    foreach ($failure in $manifest.failedExports) { $report += "- $($failure.name): $($failure.message)" }
    $report | Set-Content -LiteralPath (Join-Path $libraryRoot 'IMPORT-REPORT.md') -Encoding utf8
    [pscustomobject]@{projects=$projects.Count;verifiedFiles=$checksums.Count;missingFromExport=$manifest.failedExportCount;destination=$destination} | ConvertTo-Json
} finally { $zip.Dispose() }
