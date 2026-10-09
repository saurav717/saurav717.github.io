# Reader Companion: connects this computer to the reader's Playground at https://saurav717.github.io/reader/
#   powershell -ExecutionPolicy ByPass -c "irm https://saurav717.github.io/reader/companion.ps1 | iex"
$ErrorActionPreference = 'Stop'
$wheel = 'https://saurav717.github.io/reader/companion/reader_companion-0.5.1-py3-none-any.whl'
$site = 'https://saurav717.github.io/reader/'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing uv, once (https://astral.sh/uv)...'
  irm https://astral.sh/uv/install.ps1 | iex
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
uv tool run --from $wheel reader-companion --site $site @args
