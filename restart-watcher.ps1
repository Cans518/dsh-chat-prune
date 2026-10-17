# Wait for one verified DSH process to exit, then start its executable.
# The caller closes DSH normally; this helper never terminates processes.
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$OldPid,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ExecutablePath,
  [ValidateRange(1, 600)][int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf)) {
  throw 'ExecutablePath must identify an existing DSH executable.'
}
if ([IO.Path]::GetFileName($resolvedExecutable) -ne 'DSH NEXT.exe') {
  throw 'ExecutablePath must identify DSH NEXT.exe.'
}
$oldProcess = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
if ($oldProcess -and $oldProcess.Path -ne $resolvedExecutable) {
  throw "PID $OldPid does not belong to the specified DSH executable."
}
if (-not $PSCmdlet.ShouldProcess($resolvedExecutable, "Wait for PID $OldPid and restart DSH")) {
  return
}
if ($oldProcess) {
  Write-Output "Waiting up to $TimeoutSeconds seconds for DSH PID $OldPid to close normally."
  if (-not $oldProcess.WaitForExit($TimeoutSeconds * 1000)) {
    throw 'DSH is still open. No process was terminated and no second instance was started.'
  }
}
$remaining = @(Get-Process -Name 'DSH NEXT' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $resolvedExecutable })
if ($remaining.Count -gt 0) {
  throw 'DSH processes from this installation are still active. Close them normally and retry.'
}
Start-Process -FilePath $resolvedExecutable
Write-Output 'DSH launch requested.'
