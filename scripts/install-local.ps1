# Update an existing local DSH installation, preserving its plugin configuration.
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$profileRoot = [IO.Path]::GetFullPath((Join-Path $DshHome "profiles\$Profile"))
$installedRoot = Join-Path $profileRoot 'node_modules\dsh-delete-chat'
if (-not (Test-Path -LiteralPath (Join-Path $installedRoot 'package.json') -PathType Leaf)) {
  throw 'No existing installation found. Use the first-install instructions in README.md.'
}
$profilePackage = Get-Content -LiteralPath (Join-Path $profileRoot 'package.json') -Raw | ConvertFrom-Json
if ('dsh-delete-chat' -notin @($profilePackage.dsh.profile.bundles)) {
  throw 'The profile does not enable this bundle. See README.md before updating.'
}
$runtimeFiles = @(
  'lib/index.js', 'client-core.js', 'client.js', 'client-slot.js', 'package.json',
  'README.md', 'AUDIT.md', 'CONTRIBUTING.md', 'LICENSE',
  'assets/icon.svg', 'docs/technical-reference.md'
)
foreach ($relativeFile in $runtimeFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relativeFile) -PathType Leaf)) {
    throw "Missing source file: $relativeFile. Build and verify the plugin first."
  }
}
if (-not $PSCmdlet.ShouldProcess($installedRoot, 'Back up and update verified plugin files, preserving cordis.patch.yml')) {
  return
}

$backupRoot = Join-Path $sourceRoot ('.diagnostics\installation-backup\' + [Guid]::NewGuid().ToString())
$originalFiles = @()
foreach ($relativeFile in @($runtimeFiles) + @('cordis.patch.yml')) {
  $installedFile = Join-Path $installedRoot $relativeFile
  if (Test-Path -LiteralPath $installedFile -PathType Leaf) {
    $backupFile = Join-Path $backupRoot $relativeFile
    New-Item -ItemType Directory -Path (Split-Path -Parent $backupFile) -Force | Out-Null
    Copy-Item -LiteralPath $installedFile -Destination $backupFile -Force
    $originalFiles += $relativeFile
  }
}
try {
  foreach ($relativeFile in $runtimeFiles) {
    $sourceFile = Join-Path $sourceRoot $relativeFile
    $installedFile = Join-Path $installedRoot $relativeFile
    New-Item -ItemType Directory -Path (Split-Path -Parent $installedFile) -Force | Out-Null
    Copy-Item -LiteralPath $sourceFile -Destination $installedFile -Force
    if ((Get-FileHash -LiteralPath $sourceFile).Hash -ne (Get-FileHash -LiteralPath $installedFile).Hash) {
      throw "Installed file differs from verified source: $relativeFile"
    }
  }
} catch {
  foreach ($relativeFile in $originalFiles) {
    Copy-Item -LiteralPath (Join-Path $backupRoot $relativeFile) -Destination (Join-Path $installedRoot $relativeFile) -Force
  }
  throw
}
Write-Output "Updated: $installedRoot"
Write-Output "Previous files: $backupRoot"
Write-Output 'Configuration preserved. The running DSH process was not restarted; changes apply on normal restart.'
