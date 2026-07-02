//! Arming the codex `SessionStart` hook purely from CLI overrides — the codex
//! leg of session identity v2 ([F7]/[F8]).
//!
//! codex refuses untrusted hooks unless `[hooks.state.<key>]` carries a
//! `trusted_hash` matching its own fingerprint of the hook's NORMALIZED
//! identity. This module reproduces that fingerprint bit-for-bit (verified
//! against codex-rs `rust-v0.142.5`: `config/src/fingerprint.rs` +
//! `hooks/src/engine/discovery.rs`, corroborated by codex's own
//! `hooks_list.rs` test suite) so the hook can be defined AND trusted in one
//! spawn's argv, never touching the user's `~/.codex/config.toml`.
//!
//! Two upstream sharp edges are encoded here:
//! - the hook `command` is a SHELL LINE (run via `$SHELL -lc`), not argv;
//! - the `-c` dotted-path splitter has no quoting, so `hooks.state` must be
//!   passed as ONE inline-table value with the state key as a quoted string.

use sha2::{Digest, Sha256};

/// The trust-state key for a hook defined via `-c` (the SessionFlags layer):
/// `<layer path>:<event>:<matcher-group index>:<handler index>`.
pub const SESSION_FLAGS_STATE_KEY: &str = "/<session-flags>/config.toml:session_start:0:0";

/// The `-c` override args that define and trust one SessionStart command
/// hook. Prepend to the spawn args (global flags precede subcommands).
pub fn cli_args(hook_command: &str) -> Vec<String> {
    let config = format!(
        "hooks.SessionStart=[{{hooks=[{{type=\"command\",command={}}}]}}]",
        toml_basic_string(hook_command)
    );
    let state = format!(
        "hooks.state={{\"{SESSION_FLAGS_STATE_KEY}\" = {{trusted_hash = \"{}\"}}}}",
        trusted_hash(hook_command)
    );
    vec!["-c".into(), config, "-c".into(), state]
}

/// codex's fingerprint of the normalized hook identity:
/// `sha256:<hex>` over the compact, key-sorted JSON of
/// `{event_name, hooks:[{async, command, timeout, type}]}` — defaults applied
/// (`timeout` 600, `async` false), `None` fields omitted, matcher absent.
pub fn trusted_hash(hook_command: &str) -> String {
    // serde_json's default Map is sorted (BTreeMap); inserting in alphabetical
    // order keeps this correct even under the preserve_order feature.
    let mut handler = serde_json::Map::new();
    handler.insert("async".into(), false.into());
    handler.insert("command".into(), hook_command.into());
    handler.insert("timeout".into(), 600u64.into());
    handler.insert("type".into(), "command".into());

    let mut identity = serde_json::Map::new();
    identity.insert("event_name".into(), "session_start".into());
    identity.insert(
        "hooks".into(),
        vec![serde_json::Value::Object(handler)].into(),
    );

    let bytes = serde_json::to_vec(&serde_json::Value::Object(identity)).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("sha256:{hex}")
}

/// Quote a path for use inside the hook's shell command line (single quotes,
/// `'\''` escaping) — KeepDeck.app can live under a path with spaces.
pub fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

/// A TOML basic string (double-quoted, `\` and `"` escaped).
fn toml_basic_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worked example verified against codex-rs 0.142.5 (its own
    /// hooks_list test suite reimplements the same chain) — if this hash ever
    /// drifts, codex changed its fingerprint and the port must be re-checked.
    #[test]
    fn reproduces_the_verified_codex_fingerprint() {
        assert_eq!(
            trusted_hash("/Applications/KeepDeck.app/Contents/Resources/kd-codex-hook"),
            "sha256:548f36baa64bfc51ad92bdb9e70bc95128c1710566ff6d35da5e8af8d7b51d26"
        );
    }

    #[test]
    fn cli_args_define_and_trust_in_one_invocation() {
        let args = cli_args("/bin/sh '/x/kd-codex-hook.sh'");
        assert_eq!(args.len(), 4);
        assert_eq!(args[0], "-c");
        assert_eq!(
            args[1],
            "hooks.SessionStart=[{hooks=[{type=\"command\",command=\"/bin/sh '/x/kd-codex-hook.sh'\"}]}]"
        );
        assert_eq!(args[2], "-c");
        // The state key rides INSIDE the value as a quoted key — the -c
        // dotted-path splitter would mangle it on the left-hand side.
        assert!(args[3].starts_with(&format!(
            "hooks.state={{\"{SESSION_FLAGS_STATE_KEY}\" = {{trusted_hash = \"sha256:"
        )));
    }

    #[test]
    fn quoting_survives_awkward_paths() {
        assert_eq!(
            shell_quote("/Apps/Keep Deck's Stuff/hook"),
            r"'/Apps/Keep Deck'\''s Stuff/hook'"
        );
        let args = cli_args("/bin/sh '/tmp/a \"b\"/hook'");
        assert!(args[1].contains(r#"command="/bin/sh '/tmp/a \"b\"/hook'""#));
    }
}
