#!/bin/sh
# Reader Companion setup: installs the Companion on this computer for the reader at https://saurav717.github.io/reader/,
# with the VS Code extension, and starts it at every login.
#   curl -LsSf https://saurav717.github.io/reader/companion-setup.sh | sh
# Anything after "sh -s --" is passed on to reader-companion setup: --no-vscode, --no-login, --root DIR.
set -e
WHEEL="https://saurav717.github.io/reader/companion/reader_companion-0.7.5-py3-none-any.whl"
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
# uv's own Python, never /usr/bin/python3: on a Mac without Xcode's tools that one asks to install them.
export UV_PYTHON_PREFERENCE=only-managed
echo "Installing the Reader Companion…"
"$UV" tool install --force --quiet --python 3.12 --from "$WHEEL" reader-companion
BIN="$("$UV" tool dir --bin 2>/dev/null || echo "$HOME/.local/bin")"
exec "$BIN/reader-companion" setup --site "$SITE" "$@"
