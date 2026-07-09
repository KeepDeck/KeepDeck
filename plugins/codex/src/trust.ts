/**
 * Arming the codex `SessionStart` hook purely from CLI overrides.
 *
 * codex refuses untrusted hooks unless `[hooks.state.<key>]` carries a
 * `trusted_hash` matching its own fingerprint of the hook's NORMALIZED
 * identity. This module reproduces that fingerprint bit-for-bit (verified
 * against codex-rs `rust-v0.142.5`: `config/src/fingerprint.rs` +
 * `hooks/src/engine/discovery.rs`; a straight port of the host's former
 * Rust `codex_hook` module, pinned by the same worked example) so the hook
 * can be defined AND trusted in one spawn's argv, never touching the user's
 * `~/.codex/config.toml`.
 *
 * Two upstream sharp edges are encoded here:
 * - the hook `command` is a SHELL LINE (run via `$SHELL -lc`), not argv;
 * - the `-c` dotted-path splitter has no quoting, so `hooks.state` must be
 *   passed as ONE inline-table value with the state key as a quoted string.
 */

/** The trust-state key for a hook defined via `-c` (the SessionFlags layer):
 * `<layer path>:<event>:<matcher-group index>:<handler index>`. */
export const SESSION_FLAGS_STATE_KEY =
  "/<session-flags>/config.toml:session_start:0:0";

/** The `-c` override args that define and trust one SessionStart command
 * hook. Prepend to the spawn args (global flags precede subcommands). */
export async function cliArgs(hookCommand: string): Promise<string[]> {
  const config = `hooks.SessionStart=[{hooks=[{type="command",command=${tomlBasicString(hookCommand)}}]}]`;
  const state = `hooks.state={"${SESSION_FLAGS_STATE_KEY}" = {trusted_hash = "${await trustedHash(hookCommand)}"}}`;
  return ["-c", config, "-c", state];
}

/** codex's fingerprint of the normalized hook identity:
 * `sha256:<hex>` over the compact, KEY-SORTED JSON of
 * `{event_name, hooks:[{async, command, timeout, type}]}` — defaults applied
 * (`timeout` 600, `async` false), `None` fields omitted, matcher absent.
 * JSON.stringify preserves insertion order, so the literals below are
 * written in alphabetical key order to match serde_json's sorted map. */
export async function trustedHash(hookCommand: string): Promise<string> {
  const identity = {
    event_name: "session_start",
    hooks: [
      { async: false, command: hookCommand, timeout: 600, type: "command" },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** Quote a path for use inside the hook's shell command line (single quotes,
 * `'\''` escaping) — KeepDeck.app can live under a path with spaces. */
export function shellQuote(path: string): string {
  return `'${path.split("'").join(`'\\''`)}'`;
}

/** A TOML basic string (double-quoted, `\` and `"` escaped). */
function tomlBasicString(value: string): string {
  return `"${value.split("\\").join("\\\\").split('"').join('\\"')}"`;
}
