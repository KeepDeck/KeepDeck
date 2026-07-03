//! Durable deck state ([F7]) — an OPAQUE JSON document owned by the webview.
//!
//! All schema knowledge (validation, versioning, migration) lives in
//! `src/domain/persist.ts`, next to the model it mirrors; this adapter only
//! moves the bytes durably. Writes are atomic (tmp + rename) so a crash
//! mid-write can never leave a torn `deck.json`, and a document the webview
//! rejects is quarantined to `deck.json.bak` instead of being overwritten by
//! the next save.

use std::fs;
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use tauri::Manager;

const FILE: &str = "deck.json";

/// The stored deck JSON, or `None` on first run. `(async)`, like every
/// command here: disk IO stays off the main thread (the frontend already
/// serializes saves, so ordering is preserved).
#[tauri::command(async)]
pub fn deck_state_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    load(&state_path(&app)?).map_err(|e| e.to_string())
}

/// Persist the deck JSON (already serialized and versioned by the webview).
#[tauri::command(async)]
pub fn deck_state_save(app: tauri::AppHandle, json: String) -> Result<(), String> {
    save_atomic(&state_path(&app)?, &json).map_err(|e| e.to_string())
}

/// The webview failed to parse/validate the stored deck — keep the evidence
/// as `deck.json.bak` so the next save can't silently destroy it.
#[tauri::command(async)]
pub fn deck_state_quarantine(app: tauri::AppHandle) -> Result<(), String> {
    quarantine(&state_path(&app)?).map_err(|e| e.to_string())
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(FILE))
}

fn load(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(json) => Ok(Some(json)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn save_atomic(path: &Path, json: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)
}

fn quarantine(path: &Path) -> io::Result<()> {
    match fs::rename(path, path.with_extension("json.bak")) {
        // Nothing on disk to quarantine is fine (e.g. the file vanished).
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::{load, quarantine, save_atomic};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A unique temp file path per test (std-only; no tempfile dependency).
    fn temp_deck() -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "kd-state-test-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ))
            .join("deck.json")
    }

    #[test]
    fn round_trips_and_overwrites_atomically() {
        let path = temp_deck();
        assert_eq!(load(&path).unwrap(), None); // first run

        save_atomic(&path, r#"{"version":1}"#).unwrap();
        assert_eq!(load(&path).unwrap().as_deref(), Some(r#"{"version":1}"#));

        save_atomic(&path, r#"{"version":1,"activeId":"ws-2"}"#).unwrap();
        assert_eq!(
            load(&path).unwrap().as_deref(),
            Some(r#"{"version":1,"activeId":"ws-2"}"#)
        );
        // The tmp staging file never survives a completed save.
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn quarantine_preserves_the_rejected_document() {
        let path = temp_deck();
        save_atomic(&path, "not json").unwrap();
        quarantine(&path).unwrap();

        assert_eq!(load(&path).unwrap(), None);
        assert_eq!(
            std::fs::read_to_string(path.with_extension("json.bak")).unwrap(),
            "not json"
        );
    }

    #[test]
    fn quarantine_of_a_missing_file_is_a_no_op() {
        assert!(quarantine(&temp_deck()).is_ok());
    }
}
