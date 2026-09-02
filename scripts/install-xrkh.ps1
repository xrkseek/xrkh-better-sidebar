# One-shot install for XRK-Harness (Windows).
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/install-xrkh.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install-xrkh.ps1 -Version 0.17.1
param(
  [string]$Version = "latest",
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$pkg = if ($Version -and $Version -ne "latest") { "xrk-better-sidebar@$Version" } else { "xrk-better-sidebar@latest" }

$xrkh = Get-Command xrkh -ErrorAction SilentlyContinue
if (-not $xrkh) {
  Write-Host "xrkh not on PATH — using npx @xrkseek/harness-cli"
  $add = { param($a) npx -y @xrkseek/harness-cli @a }
  & npx -y @xrkseek/harness-cli plugin add $pkg
  if ($Restart) { & npx -y @xrkseek/harness-cli restart }
} else {
  & xrkh plugin add $pkg
  if ($Restart) { & xrkh restart }
}

Write-Host "Done. Hard-refresh the browser (Ctrl+Shift+R)."
