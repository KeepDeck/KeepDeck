#!/usr/bin/env bash
#
# Shared helpers for building and locating the KeepDeck release .app bundle on
# macOS. Sourced by build-macos.sh (local dmg) and the release job in
# .github/workflows/version-bump.yml, so the build/find details live in one
# place. Every function assumes the caller has already `cd`-ed to the repo root.

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
