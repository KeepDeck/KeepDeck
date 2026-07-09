#!/usr/bin/env bash
#
# Shared helpers for building, locating and installing the KeepDeck release
# .app bundle on macOS. Sourced by:
#   - build-macos.sh   → assembles a drag-to-Applications .dmg
#   - install-macos.sh → drops the .app straight into /Applications
#
# Keeping the `find`/arch/swap details in one place stops the two entry scripts
# from drifting. Every function assumes the caller has already `cd`-ed to the
# repo root.

# Build the release .app bundle. Extra args (e.g. --target universal-apple-darwin)
# pass straight through to `tauri build`. Signing env vars (APPLE_SIGNING_IDENTITY,
# APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID) flow through Tauri untouched.
build_keepdeck_app() {
  echo "==> Building KeepDeck.app (Tauri release bundle)"
  pnpm tauri build --bundles app "$@"
}

# Echo the path to the freshly built .app on stdout (diagnostics go to stderr,
# so `app=$(locate_keepdeck_app)` captures only the path). Matches --target
# subdirs like target/universal-apple-darwin/release/bundle/macos/. Returns
# non-zero if no bundle is found.
locate_keepdeck_app() {
  local app_path
  # `|| true` guards the pipeline so an early-closing `head` under
  # `set -o pipefail` doesn't abort the caller.
  app_path="$(find target -type d -path '*/release/bundle/macos/*.app' -prune 2>/dev/null | head -n1 || true)"
  if [[ -z "$app_path" ]]; then
    echo "error: no .app bundle found under target/**/release/bundle/macos/" >&2
    return 1
  fi
  printf '%s\n' "$app_path"
}

# Is a bundle with this app name currently running? $1 = app name (e.g. KeepDeck).
# Returns 0 when a matching process exists, 1 otherwise.
keepdeck_app_running() {
  pgrep -x "$1" >/dev/null 2>&1
}

# Install a built .app into a destination directory, echoing the installed path.
#   $1 = source .app path, $2 = destination directory (e.g. /Applications)
# Stages the copy next to the target then swaps it in, so a failed/partial copy
# can never leave a half-written bundle at the destination. Removing the old
# bundle while a copy of it runs is safe on APFS — the running process keeps its
# files by inode until it exits. Clears the quarantine xattr afterwards so an
# unsigned local build isn't blocked by Gatekeeper on first launch.
install_keepdeck_app() {
  local src="$1" dest="$2"
  local app_name target incoming
  app_name="$(basename "$src" .app)"
  target="${dest%/}/${app_name}.app"
  incoming="${dest%/}/.${app_name}.app.incoming"

  mkdir -p "$dest"
  rm -rf "$incoming"
  ditto "$src" "$incoming"
  rm -rf "$target"
  mv "$incoming" "$target"
  xattr -cr "$target" 2>/dev/null || true

  printf '%s\n' "$target"
}
