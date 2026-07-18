//! Durable opaque JSON documents owned by the webview: the deck state
//! ([F7], `deck.json`) and the app settings ([F6], `settings.json`).
//!
//! All schema knowledge (validation, versioning, migration) lives in
//! `src/domain/deck/persist.ts` / `src/domain/settings`, next to the models it
//! mirrors; this adapter only moves the bytes durably. The documents live
//! under `<keepdeck_home>` (legacy installs are adopted by
//! `crate::migration`). Writes are atomic (tmp + rename) so a crash
//! mid-write can never leave a torn document, and a document the webview
//! rejects is quarantined to a `.bak` sibling instead of being overwritten
//! by the next save.

use std::fs;
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};

const DECK_FILE: &str = "deck.json";
const SETTINGS_FILE: &str = "settings.json";
const USAGE_CACHE_FILE: &str = "usage-cache.json";

/// The stored deck JSON, or `None` on first run. `(async)`, like every
/// command here: disk IO stays off the main thread (the frontend already
/// serializes saves, so ordering is preserved).
#[tauri::command(async)]
pub fn deck_state_load() -> Result<Option<String>, String> {
    load(&state_path()?).map_err(|e| e.to_string())
}

/// Persist the deck JSON (already serialized and versioned by the webview).
#[tauri::command(async)]
pub fn deck_state_save(json: String) -> Result<(), String> {
    save_atomic(&state_path()?, &json).map_err(|e| e.to_string())
}

/// The webview failed to parse/validate the stored deck — keep the evidence
/// as `deck.json.bak` so the next save can't silently destroy it.
#[tauri::command(async)]
pub fn deck_state_quarantine() -> Result<(), String> {
    quarantine(&state_path()?).map_err(|e| e.to_string())
}

/// The last-known usage snapshot (account rate-limit windows), or `None`.
/// A CACHE, not a document: the webview validates tolerantly and a bad file
/// just means an empty bar until fresh reports — no quarantine ceremony.
#[tauri::command(async)]
pub fn usage_cache_load() -> Result<Option<String>, String> {
    load(&usage_cache_path()?).map_err(|e| e.to_string())
}

/// Persist the usage snapshot (already serialized by the webview).
#[tauri::command(async)]
pub fn usage_cache_save(json: String) -> Result<(), String> {
    save_atomic(&usage_cache_path()?, &json).map_err(|e| e.to_string())
}

/// The stored settings JSON, or `None` on first run ([F6]).
#[tauri::command(async)]
pub fn settings_load() -> Result<Option<String>, String> {
    load(&settings_path()?).map_err(|e| e.to_string())
}

/// Persist the settings JSON (already serialized and versioned by the webview).
#[tauri::command(async)]
pub fn settings_save(json: String) -> Result<(), String> {
    save_atomic(&settings_path()?, &json).map_err(|e| e.to_string())
}

/// The webview failed to parse the stored settings — keep the evidence as
/// `settings.json.bak` (the file is hand-editable, so a typo must not be
/// silently destroyed by the next save).
#[tauri::command(async)]
pub fn settings_quarantine() -> Result<(), String> {
    quarantine(&settings_path()?).map_err(|e| e.to_string())
}

fn state_path() -> Result<PathBuf, String> {
    doc_path(DECK_FILE)
}

fn settings_path() -> Result<PathBuf, String> {
    doc_path(SETTINGS_FILE)
}

fn usage_cache_path() -> Result<PathBuf, String> {
    doc_path(USAGE_CACHE_FILE)
}

fn doc_path(file: &str) -> Result<PathBuf, String> {
    let dir = crate::paths::keepdeck_home().ok_or("no home directory for app state")?;
    Ok(dir.join(file))
}

fn load(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(json) => Ok(Some(json)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn save_atomic(path: &Path, json: &str) -> io::Result<()> {
    write_atomic(path, json.as_bytes())
}

/// Write bytes durably: a `.tmp` sibling is fsynced, then renamed over the
/// destination, creating parent directories on the way. Shared with
/// `crate::migration`, which copies legacy documents with the same guarantee.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// Quarantined generations kept per document. One slot proved too few: the
/// second quarantine silently destroyed the evidence of the first.
const KEEP_BACKUPS: usize = 5;

fn quarantine(path: &Path) -> io::Result<()> {
    let name = match path.file_name() {
        Some(n) => n.to_string_lossy().into_owned(),
        None => return Ok(()),
    };
    // deck.json → deck.json.bak.<millis>; bump on the (theoretical) same-
    // millisecond collision instead of renaming over an older backup.
    let mut stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut target = path.with_file_name(format!("{name}.bak.{stamp}"));
    while target.exists() {
        stamp += 1;
        target = path.with_file_name(format!("{name}.bak.{stamp}"));
    }
    match fs::rename(path, &target) {
        // Nothing on disk to quarantine is fine (e.g. the file vanished).
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        other => other?,
    }
    prune_backups(path, KEEP_BACKUPS);
    Ok(())
}

/// Best-effort: keep the newest `keep` backups of `path` — everything named
/// `<file>.bak*`, the legacy un-suffixed `.bak` included — and delete the
/// rest. The quarantine itself already succeeded; a failing prune only logs.
fn prune_backups(path: &Path, keep: usize) {
    let (Some(dir), Some(name)) = (
        path.parent(),
        path.file_name().map(|n| n.to_string_lossy().into_owned()),
    ) else {
        return;
    };
    let prefix = format!("{name}.bak");
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut backups: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    backups.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    for (_, old) in backups.into_iter().skip(keep) {
        if let Err(e) = fs::remove_file(&old) {
            log::warn!("backup prune failed for {}: {e}", old.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{load, quarantine, save_atomic, KEEP_BACKUPS};
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

    /// Every backup generation of `path`, any suffix style.
    fn backups_of(path: &std::path::Path) -> Vec<PathBuf> {
        let prefix = format!("{}.bak", path.file_name().unwrap().to_string_lossy());
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
            .map(|e| e.path())
            .collect()
    }

    #[test]
    fn quarantine_preserves_the_rejected_document() {
        let path = temp_deck();
        save_atomic(&path, "not json").unwrap();
        quarantine(&path).unwrap();

        assert_eq!(load(&path).unwrap(), None);
        let backups = backups_of(&path);
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), "not json");
    }

    #[test]
    fn repeated_quarantines_keep_distinct_evidence() {
        // One slot proved too few: the second quarantine used to destroy the
        // first one's evidence by renaming over it.
        let path = temp_deck();
        save_atomic(&path, "first").unwrap();
        quarantine(&path).unwrap();
        save_atomic(&path, "second").unwrap();
        quarantine(&path).unwrap();

        let mut contents: Vec<String> = backups_of(&path)
            .iter()
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect();
        contents.sort();
        assert_eq!(contents, vec!["first".to_string(), "second".to_string()]);
    }

    #[test]
    fn prune_keeps_only_the_newest_generations() {
        let path = temp_deck();
        for i in 0..(KEEP_BACKUPS + 2) {
            save_atomic(&path, &format!("gen-{i}")).unwrap();
            quarantine(&path).unwrap();
        }
        let backups = backups_of(&path);
        assert_eq!(backups.len(), KEEP_BACKUPS);
        // The newest generation always survives.
        let contents: Vec<String> = backups
            .iter()
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect();
        assert!(contents.contains(&format!("gen-{}", KEEP_BACKUPS + 1)));
    }

    #[test]
    fn legacy_unsuffixed_bak_counts_toward_the_limit() {
        let path = temp_deck();
        save_atomic(&path.with_extension("json.bak"), "legacy").unwrap();
        for i in 0..KEEP_BACKUPS {
            save_atomic(&path, &format!("gen-{i}")).unwrap();
            quarantine(&path).unwrap();
        }
        // legacy + KEEP_BACKUPS new ones → pruned back to the limit, and the
        // legacy file (oldest by mtime) is what went.
        let backups = backups_of(&path);
        assert_eq!(backups.len(), KEEP_BACKUPS);
        assert!(!path.with_extension("json.bak").exists());
    }

    #[test]
    fn quarantine_of_a_missing_file_is_a_no_op() {
        assert!(quarantine(&temp_deck()).is_ok());
    }
}
