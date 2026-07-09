#!/bin/sh
#
# KeepDeck installer. Downloads the latest build and installs it to
# /Applications. Run it directly:
#
#   curl -fsSL https://raw.githubusercontent.com/KeepDeck/KeepDeck/main/install.sh | sh
#
# The app is unsigned, so this strips the download's quarantine attribute; it
# then opens without a Gatekeeper prompt. macOS only for now.
#
# Env overrides:
#   KEEPDECK_DEST  install directory (default /Applications)
#   KEEPDECK_URL   a specific .zip to install instead of the latest release
set -eu

REPO="KeepDeck/KeepDeck"
DEST="${KEEPDECK_DEST:-/Applications}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "KeepDeck currently supports macOS only." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) asset="KeepDeck-macos-arm64.zip" ;;  # Apple Silicon
  x86_64) asset="KeepDeck-macos-x64.zip" ;;   # Intel
  *) echo "unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

URL="${KEEPDECK_URL:-https://github.com/$REPO/releases/download/latest/$asset}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading KeepDeck..."
curl -fL --progress-bar "$URL" -o "$tmp/keepdeck.zip"

echo "Unpacking..."
ditto -x -k "$tmp/keepdeck.zip" "$tmp/app"
src="$(find "$tmp/app" -maxdepth 2 -type d -name '*.app' | head -n1)"
if [ -z "$src" ]; then
  echo "error: no .app found in the download." >&2
  exit 1
fi
name="$(basename "$src")"

# Fall back to ~/Applications only when the default system folder isn't writable
# (avoids a sudo prompt inside curl | sh). An explicit KEEPDECK_DEST is honored.
if [ "$DEST" = "/Applications" ] && [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  echo "note: /Applications isn't writable; installing to $DEST instead."
fi
mkdir -p "$DEST"
target="$DEST/$name"

running=""
if pgrep -x "$(basename "$name" .app)" >/dev/null 2>&1; then
  running=1
fi

echo "Installing to $target..."
rm -rf "$target"
ditto "$src" "$target"
# Unsigned build: strip quarantine so Gatekeeper doesn't block the first launch.
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

if [ -n "$running" ]; then
  echo "Done. KeepDeck was running. Quit and reopen it to load this build."
else
  echo "Done. Open KeepDeck from Launchpad or Spotlight."
fi
