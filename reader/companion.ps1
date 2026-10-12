# Reader Companion: connects this computer to the reader's Playground at https://saurav717.github.io/reader/
#   powershell -ExecutionPolicy ByPass -c "irm https://saurav717.github.io/reader/companion.ps1 | iex"
$ErrorActionPreference = 'Stop'
$wheel = 'https://saurav717.github.io/reader/companion/reader_companion-0.14.0-py3-none-any.whl'
$site = 'https://saurav717.github.io/reader/'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing uv, once (https://astral.sh/uv)...'
  irm https://astral.sh/uv/install.ps1 | iex
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
# uv's Python 3.12, never the newest: pywinpty (the terminal, on Windows) has no wheel for a brand-new Python, and building it needs NuGet.
uv tool run --python 3.12 --from $wheel reader-companion --site $site @args
