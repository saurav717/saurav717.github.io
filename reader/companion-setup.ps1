# Reader Companion setup: installs the Companion on this computer for the reader at https://saurav717.github.io/reader/,
# with the VS Code extension, and starts it at every login.
#   powershell -ExecutionPolicy ByPass -c "irm https://saurav717.github.io/reader/companion-setup.ps1 | iex"
$ErrorActionPreference = 'Stop'
$wheel = 'https://saurav717.github.io/reader/companion/reader_companion-0.11.0-py3-none-any.whl'
$site = 'https://saurav717.github.io/reader/'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing uv, once (https://astral.sh/uv)...'
  irm https://astral.sh/uv/install.ps1 | iex
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
Write-Host 'Installing the Reader Companion...'
uv tool install --force --quiet --from $wheel reader-companion
$bin = uv tool dir --bin
& (Join-Path $bin 'reader-companion.exe') setup --site $site @args
