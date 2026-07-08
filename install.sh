#!/usr/bin/env bash
#
# Build KeepDeck and install it straight into /Applications — no dmg, no manual
# drag. One command: `./install.sh`.
#
# It builds the release .app (the same build as build-macos.sh, minus the dmg),
# swaps it into the destination, and clears the quarantine xattr so Gatekeeper
# lets the unsigned local build launch.
#
# If KeepDeck is already running it is NOT touched: the new bundle is installed
# underneath the running one, and you're told to restart the app to load it.
#
# Usage:
#   ./install.sh                                  # build + install to /Applications
#   ./install.sh --dest ~/Applications            # install for the current user only
#   ./install.sh --target universal-apple-darwin  # extra args pass through to tauri
#
# Code signing: export APPLE_SIGNING_IDENTITY (plus APPLE_ID / APPLE_PASSWORD /
# APPLE_TEAM_ID to notarize) before running; they flow straight through Tauri.
set -euo pipefail

# Run from the repo root regardless of where the script is invoked from.
cd "$(dirname "$0")"
# shellcheck source=scripts/macos-app.sh
source "scripts/macos-app.sh"

dest="/Applications"
passthrough=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) dest="${2:?--dest needs a directory}"; shift 2 ;;
    --dest=*) dest="${1#*=}"; shift ;;
    *) passthrough+=("$1"); shift ;;
  esac
done

# Expand a leading ~ the shell didn't (e.g. --dest=~/Applications).
dest="${dest/#\~/$HOME}"

# ${arr[@]+"${arr[@]}"} expands to nothing on an empty array — required because
# macOS ships bash 3.2, where "${arr[@]}" on an empty array trips `set -u`.
build_keepdeck_app ${passthrough[@]+"${passthrough[@]}"}
app_path="$(locate_keepdeck_app)"
app_name="$(basename "$app_path" .app)"

# Note whether a copy is already running *before* we swap the bundle in.
running=0
if keepdeck_app_running "$app_name"; then
  running=1
fi

echo "==> Installing ${app_name}.app to ${dest%/}"
installed="$(install_keepdeck_app "$app_path" "$dest")"

echo "==> Done"
echo "    installed: $installed"
if [[ "$running" -eq 1 ]]; then
  echo
  echo "    $app_name is still running the previous version."
  echo "    Quit and reopen it to load this build."
else
  echo "    Open it from Launchpad / Spotlight, or: open -a \"$app_name\""
fi
