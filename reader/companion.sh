#!/bin/sh
# Reader Companion: connects this computer to the reader's Playground at https://saurav717.github.io/reader/
#   curl -LsSf https://saurav717.github.io/reader/companion.sh | sh
# Installs uv (https://docs.astral.sh/uv/) once if it isn't there, then runs the
# Companion with it. Anything after "sh -s --" is passed on: --no-browser, --root DIR.
set -e
WHEEL="https://saurav717.github.io/reader/companion/reader_companion-0.2.1-py3-none-any.whl"
SITE="https://saurav717.github.io/reader/"
if command -v uv >/dev/null 2>&1; then
  UV=uv
elif [ -x "$HOME/.local/bin/uv" ]; then
  UV="$HOME/.local/bin/uv"
elif [ -x "$HOME/.cargo/bin/uv" ]; then
  UV="$HOME/.cargo/bin/uv"
else
  echo "Installing uv, once (https://astral.sh/uv)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
fi
exec "$UV" tool run --from "$WHEEL" reader-companion --site "$SITE" "$@"
