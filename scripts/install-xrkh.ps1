# One-shot install for XRK-Harness (Windows).
param(
  [string]$Version = "latest",
  [switch]$Restart
)
$ErrorActionPreference = "Stop"
$pkg = if ($Version -and $Version -ne "latest") { "xrkh-better-sidebar@$Version" } else { "xrkh-better-sidebar@latest" }
if (Get-Command xrkh -ErrorAction SilentlyContinue) {
  & xrkh plugin add $pkg
  if ($Restart) { & xrkh restart }
} else {
  & npx -y @xrkseek/harness-cli plugin add $pkg
  if ($Restart) { & npx -y @xrkseek/harness-cli restart }
}
Write-Host "Done. Hard-refresh the browser (Ctrl+Shift+R)."
