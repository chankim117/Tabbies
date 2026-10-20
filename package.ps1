# package.ps1
#
# Builds the zip to upload to the Chrome Web Store: dist\tabbies-<version>.zip
# (the version comes from manifest.json). Only what the extension needs goes
# in: manifest.json, the pages and scripts, shared\ and icons\. Not the
# README, docs, store images or git files.
#
# Run it from this folder:
#   powershell -ExecutionPolicy Bypass -File package.ps1
#
# It uses .NET's zip classes rather than Compress-Archive, because Windows
# PowerShell's Compress-Archive writes folder paths with backslashes, which
# the Chrome Web Store can reject.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version

$files = @(Get-Item (Join-Path $root 'manifest.json'))
$files += Get-ChildItem -Path (Join-Path $root '*') -File -Include *.html, *.js
$files += Get-ChildItem -Path (Join-Path $root 'shared'), (Join-Path $root 'icons') -File -Recurse

$zipPath = Join-Path $root "dist\tabbies-$version.zip"
New-Item -ItemType Directory -Force -Path (Split-Path $zipPath) | Out-Null
if (Test-Path $zipPath) { Remove-Item $zipPath }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($file in $files) {
    # Paths inside the zip are relative to this folder, with forward slashes.
    $name = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name, 'Optimal') | Out-Null
  }
} finally {
  $zip.Dispose()
}

$size = [math]::Round((Get-Item $zipPath).Length / 1KB)
Write-Output "Built dist\tabbies-$version.zip: $($files.Count) files, $size KB"
