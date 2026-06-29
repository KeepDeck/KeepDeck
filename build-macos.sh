#!/usr/bin/env bash
#
# Build a distributable macOS .app + .dmg for KeepDeck.
#
# Why not just `tauri build --bundles dmg`?
#   Tauri's dmg bundler styles the disk-image window with an AppleScript that
#   tells Finder how to lay out the icons. That step needs the *driving*
#   process to hold macOS Automation permission for Finder (System Settings →
#   Privacy & Security → Automation). In a headless / CI / agent shell that
#   permission can't be granted interactively, so the bundler aborts with:
#       execution error: Not authorised to send Apple events to Finder. (-1743)
#   and you get no dmg at all.
#
#   So by default we build only the .app with Tauri (no Finder involved) and
#   assemble the dmg ourselves with hdiutil — a plain drag-to-Applications
#   image that builds anywhere. Pass --styled to use Tauri's prettier,
#   Finder-dependent dmg instead (run it from a Terminal that has been granted
#   Automation → Finder).
#
# Usage:
#   ./build-macos.sh                       # headless-safe .app + plain dmg
#   ./build-macos.sh --styled              # Tauri's styled dmg (needs Finder perm)
#   ./build-macos.sh --target universal-apple-darwin   # extra args pass through
#
# Code signing: set APPLE_SIGNING_IDENTITY (+ APPLE_ID / APPLE_PASSWORD /
# APPLE_TEAM_ID for notarization) before running; Tauri signs the .app during
# the build and those env vars pass straight through.
#
set -euo pipefail

# Run from the repo root regardless of where the script is invoked from.
cd "$(dirname "$0")"

styled=0
passthrough=()
for arg in "$@"; do
  case "$arg" in
    --styled) styled=1 ;;
    *) passthrough+=("$arg") ;;
  esac
done

if [[ "$styled" -eq 1 ]]; then
  echo "==> tauri build --bundles dmg (styled; needs Automation → Finder permission)"
  # ${arr[@]+"${arr[@]}"} expands to nothing on an empty array — required because
  # macOS ships bash 3.2, where "${arr[@]}" on an empty array trips `set -u`.
  exec pnpm tauri build --bundles dmg ${passthrough[@]+"${passthrough[@]}"}
fi

echo "==> Building KeepDeck.app (Tauri release bundle)"
pnpm tauri build --bundles app ${passthrough[@]+"${passthrough[@]}"}

# Locate the freshly built .app (also matches --target subdirs like
# target/universal-apple-darwin/release/bundle/macos/). `|| true` guards the
# pipeline so an early-closing `head` under `set -o pipefail` doesn't abort us.
app_path="$(find target -type d -path '*/release/bundle/macos/*.app' -prune 2>/dev/null | head -n1 || true)"
if [[ -z "$app_path" ]]; then
  echo "error: no .app bundle found under target/**/release/bundle/macos/" >&2
  exit 1
fi
app_name="$(basename "$app_path" .app)"
bundle_dir="$(dirname "$(dirname "$app_path")")"   # …/release/bundle

# Version (from tauri.conf.json) + arch for the dmg filename, matching Tauri's
# own naming convention (e.g. KeepDeck_0.3.14_aarch64.dmg).
version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
case "$(uname -m)" in
  arm64) arch="aarch64" ;;
  x86_64) arch="x64" ;;
  *) arch="$(uname -m)" ;;
esac
dmg_path="${bundle_dir}/dmg/${app_name}_${version}_${arch}.dmg"
mkdir -p "$(dirname "$dmg_path")"
rm -f "$dmg_path"

echo "==> Assembling dmg with hdiutil (headless-safe, drag-to-Applications)"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -R "$app_path" "$staging/"
ln -s /Applications "$staging/Applications"
hdiutil create \
  -volname "$app_name" \
  -srcfolder "$staging" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$dmg_path" >/dev/null

echo "==> Done"
echo "    app: $app_path"
echo "    dmg: $dmg_path ($(du -h "$dmg_path" | cut -f1))"
