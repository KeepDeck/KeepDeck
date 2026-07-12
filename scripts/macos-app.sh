#!/usr/bin/env bash
#
# Shared helpers for building and locating the KeepDeck release .app bundle on
# macOS. Sourced by build-macos.sh (local dmg) and the build job in
# .github/workflows/build-macos.yml, so the build/find details live in one
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

# Echo the path to the updater payload (.app.tar.gz) built next to the .app
# when bundle.createUpdaterArtifacts is on; its minisign signature sits at the
# same path plus ".sig". Returns non-zero if the payload is missing.
locate_keepdeck_updater_payload() {
  local app_path payload
  app_path="$(locate_keepdeck_app)" || return 1
  payload="${app_path}.tar.gz"
  if [[ ! -f "$payload" ]]; then
    echo "error: no updater payload found at $payload" >&2
    return 1
  fi
  printf '%s\n' "$payload"
}
