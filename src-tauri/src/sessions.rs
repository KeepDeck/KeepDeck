//! The session spool — how a pane's own agent process reports its session id
//! back to KeepDeck (session identity v2, [F7]/[F8]).
//!
//! At spawn, KeepDeck arms each agent with a reporter (claude needs none — its
//! id is assigned via `--session-id`; codex gets a `SessionStart` hook,
//! opencode a plugin, both shipped inside KeepDeck and activated per
//! invocation) plus two env vars: `KEEPDECK_PANE_ID` and `KEEPDECK_SPOOL`.
//! The reporter drops a small JSON file into the spool; the watcher here
//! parses it, emits `deck://session/bound` to the webview, and consumes the
//! file. Bindings are exact by construction — the id comes from the pane's own
//! process, so parallel spawns (or agents run outside KeepDeck) can never
//! cross-bind. No timers anywhere.

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Event delivering one binding to the webview (see `src/ipc/sessions.ts`).
pub const SESSION_BOUND_EVENT: &str = "deck://session/bound";

/// What a reporter writes into the spool (extra fields are ignored, so hooks
/// may include diagnostics like the transcript path).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPostback {
    /// The pane that spawned the reporting process (`KEEPDECK_PANE_ID`).
    pub pane_id: String,
    /// The agent's own session id.
    pub session_id: String,
}

/// Where reporters drop their postbacks for this app instance.
pub fn spool_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("session-spool");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Per-install spawn-plan constants (mirrors the TS `SpawnPlanContext`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnContextDto {
    /// Where reporters drop postbacks (`KEEPDECK_SPOOL`).
    pub spool_dir: String,
    /// Ready-made codex `-c` args enabling the SessionStart hook (config +
    /// trusted hash); None until the hook resource ships (phase 3b).
    pub codex_hook_args: Option<Vec<String>>,
    /// Absolute path of the opencode session-reporter plugin (phase 3c).
    pub opencode_plugin_path: Option<String>,
}

/// The spawn-plan context, resolved once at webview boot.
#[tauri::command]
pub fn session_spawn_context(app: AppHandle) -> Result<SpawnContextDto, String> {
    Ok(SpawnContextDto {
        spool_dir: spool_dir(&app)?.to_string_lossy().into_owned(),
        codex_hook_args: codex_hook_args(&app),
        opencode_plugin_path: reporter_path(&app, "session-reporter.js"),
    })
}

/// The `-c` overrides arming the codex SessionStart reporter. Run through
/// `/bin/sh <script>` explicitly — bundling may drop the exec bit. On a codex
/// without hooks these overrides are inert (unknown `-c` keys are ignored),
/// so no version gate is needed; such a pane just stays unbound and revives
/// via latest-for-directory.
fn codex_hook_args(app: &AppHandle) -> Option<Vec<String>> {
    let script = reporter_path(app, "kd-codex-hook.sh")?;
    let command = format!("/bin/sh {}", keepdeck_history::codex_hook::shell_quote(&script));
    Some(keepdeck_history::codex_hook::cli_args(&command))
}

/// Absolute path of a reporter shipped in KeepDeck's resources, when present
/// (dev and bundle both resolve through the Resource base dir).
fn reporter_path(app: &AppHandle, name: &str) -> Option<String> {
    let path = app
        .path()
        .resolve(format!("resources/{name}"), tauri::path::BaseDirectory::Resource)
        .ok()?;
    path.is_file().then(|| path.to_string_lossy().into_owned())
}

/// Start watching the spool. Called once at app setup; the returned watcher
/// must be kept alive (it's stored in Tauri's managed state).
pub fn watch_spool(app: &AppHandle) -> Result<SpoolWatcher, String> {
    let dir = spool_dir(app)?;

    // Postbacks written while KeepDeck wasn't running belong to panes that no
    // longer exist — drop them instead of replaying stale bindings.
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }

    let emitter = app.clone();
    let watched = dir.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        let Ok(event) = event else { return };
        // Reporters write via tmp + rename, so a Create/Modify means a whole
        // file. Anything unparsable is consumed and dropped (never loops).
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            return;
        }
        for path in &event.paths {
            deliver(&emitter, path);
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&watched, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    Ok(SpoolWatcher(watcher))
}

/// Keeps the notify watcher alive for the app's lifetime (managed state).
pub struct SpoolWatcher(#[allow(dead_code)] notify::RecommendedWatcher);

/// Read → emit → consume one postback file.
fn deliver(app: &AppHandle, path: &Path) {
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return; // tmp staging files and strays
    }
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    if let Some(postback) = parse_postback(&content) {
        let _ = app.emit(SESSION_BOUND_EVENT, &postback);
    }
    let _ = fs::remove_file(path);
}

/// Parse a reporter's JSON. `None` for anything malformed — the spool is fed
/// by shell hooks, so garbage must degrade silently, never error.
pub fn parse_postback(content: &str) -> Option<SessionPostback> {
    let postback: SessionPostback = serde_json::from_str(content).ok()?;
    (!postback.pane_id.is_empty() && !postback.session_id.is_empty()).then_some(postback)
}

#[cfg(test)]
mod tests {
    use super::{parse_postback, SessionPostback};

    #[test]
    fn parses_a_reporter_postback_ignoring_extra_fields() {
        let json = r#"{"paneId":"pane-3","sessionId":"abc-123",
                       "transcriptPath":"/x/y.jsonl","agent":"codex"}"#;
        assert_eq!(
            parse_postback(json),
            Some(SessionPostback {
                pane_id: "pane-3".into(),
                session_id: "abc-123".into(),
            })
        );
    }

    #[test]
    fn rejects_garbage_and_empty_ids() {
        assert_eq!(parse_postback("not json"), None);
        assert_eq!(parse_postback("{}"), None);
        assert_eq!(parse_postback(r#"{"paneId":"","sessionId":"x"}"#), None);
        assert_eq!(parse_postback(r#"{"paneId":"p","sessionId":""}"#), None);
    }

    // The webview listens for this exact wire shape — pin it.
    #[test]
    fn postback_serializes_camel_case() {
        let json = serde_json::to_value(SessionPostback {
            pane_id: "pane-3".into(),
            session_id: "abc".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "paneId": "pane-3", "sessionId": "abc" })
        );
    }
}
