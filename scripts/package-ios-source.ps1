param(
  [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot 'dist'
}
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($destination) | Out-Null
$archivePath = Join-Path $destination "salcara-ai-ios-source-v$($package.version).zip"

$paths = @(& git -C $projectRoot ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed' }
$paths = $paths | Where-Object {
  $_ -and
  -not $_.StartsWith('remote/') -and
  -not $_.StartsWith('.github/') -and
  -not $_.StartsWith('scripts/ui-preview/') -and
  (Test-Path -LiteralPath (Join-Path $projectRoot $_) -PathType Leaf)
} | Sort-Object -Unique

if ($paths.Count -lt 100) { throw "Unexpectedly small iOS source set: $($paths.Count) files" }
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
$zip = [System.IO.Compression.ZipFile]::Open($archivePath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($path in $paths) {
    $source = Join-Path $projectRoot $path
    $name = 'salcara-image-mobile/' + $path.Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $source, $name, [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $zip.Dispose()
}
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$archivePath.sha256", "$hash  $([System.IO.Path]::GetFileName($archivePath))`n")
Write-Output "Archive: $archivePath"
Write-Output "Files: $($paths.Count)"
Write-Output "SHA-256: $hash"
