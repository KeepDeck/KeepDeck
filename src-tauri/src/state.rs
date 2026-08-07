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

use std::cmp::Reverse;
use std::fs;
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};

const DECK_FILE: &str = "deck.json";
const SETTINGS_FILE: &str = "settings.json";
const USAGE_CACHE_FILE: &str = "usage-cache.json";
const ACHIEVEMENTS_FILE: &str = "achievements.json";

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

/// The achievement ids the user has already been congratulated for. A CACHE
/// like the usage snapshot — tolerant webview read, no quarantine: the worst
/// a bad file causes is one repeated congratulation.
#[tauri::command(async)]
pub fn achievements_load() -> Result<Option<String>, String> {
    load(&achievements_path()?).map_err(|e| e.to_string())
}

/// Persist the congratulated set (already serialized by the webview).
#[tauri::command(async)]
pub fn achievements_save(json: String) -> Result<(), String> {
    save_atomic(&achievements_path()?, &json).map_err(|e| e.to_string())
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

/// Keep a copy of the settings before an app update — the restore point and
/// the evidence if the document comes back changed. See [`snapshot`].
#[tauri::command(async)]
pub fn settings_snapshot() -> Result<(), String> {
    snapshot(&settings_path()?).map_err(|e| e.to_string())
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

fn achievements_path() -> Result<PathBuf, String> {
    doc_path(ACHIEVEMENTS_FILE)
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
    write_atomic_mode(path, bytes, None)
}

/// [`write_atomic`] with an explicit unix mode for the file it creates.
///
/// The mode lands on the TEMP file BEFORE the first byte is written, so the
/// content is never briefly readable under a wider one — a window that
/// matters for the write capability's targets, which can sit outside the
/// home (`/tmp`) where no directory mode backstops them.
pub(crate) fn write_atomic_mode(
    path: &Path,
    bytes: &[u8],
    mode: Option<u32>,
) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    {
        let mut file = fs::File::create(&tmp)?;
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// The two kinds of kept generation, each with its OWN filename lane and its
/// own count. They must not share: a quarantine is rare forensic evidence the
/// user may need months later, while a pre-update copy is taken on every
/// update and is therefore always newer. Pruning by age across one shared lane
/// deletes the quarantine first — guaranteed, not merely likely — which is the
/// opposite of what either lane is for.
#[derive(Clone, Copy)]
struct BackupLane {
    /// Inserted between the file name and the stamp: `settings.json.bak.<ms>`.
    suffix: &'static str,
    keep: usize,
}

/// Rejected documents. One slot proved too few: the second quarantine silently
/// destroyed the evidence of the first.
const QUARANTINE: BackupLane = BackupLane {
    suffix: "bak",
    keep: 5,
};

/// Copies taken before an app update. Two is enough to answer "did the update
/// change my settings" for the current and the previous update; more would only
/// crowd the directory the user is meant to be able to read.
const PRE_UPDATE: BackupLane = BackupLane {
    suffix: "pre-update",
    keep: 2,
};

/// An unused `<file>.<suffix>.<millis>` sibling of `path`. `None` only for a
/// path with no file name at all. Bumps the stamp on the (theoretical) same-
/// millisecond collision rather than clobbering an older generation.
fn free_backup_target(path: &Path, lane: BackupLane) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let mut stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut target = path.with_file_name(format!("{name}.{}.{stamp}", lane.suffix));
    while target.exists() {
        stamp += 1;
        target = path.with_file_name(format!("{name}.{}.{stamp}", lane.suffix));
    }
    Some(target)
}

fn quarantine(path: &Path) -> io::Result<()> {
    let Some(target) = free_backup_target(path, QUARANTINE) else {
        return Ok(());
    };
    match fs::rename(path, &target) {
        // Nothing on disk to quarantine is fine (e.g. the file vanished).
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        other => other?,
    }
    prune_backups(path, QUARANTINE);
    Ok(())
}

/// Keep a COPY of `path` beside it, in the pre-update lane — the original stays
/// exactly where it is, and no quarantined generation is ever touched.
///
/// Taken before something that has historically been followed by "my settings
/// reset": an app update. Without a copy from before, a document that comes
/// back changed can neither be proved nor restored, and the file itself carries
/// no history. A missing source is not an error — there is simply nothing to
/// keep.
fn snapshot(path: &Path) -> io::Result<()> {
    let Some(target) = free_backup_target(path, PRE_UPDATE) else {
        return Ok(());
    };
    if let Err(e) = fs::copy(path, &target) {
        if e.kind() == ErrorKind::NotFound {
            return Ok(());
        }
        return Err(e);
    }
    prune_backups(path, PRE_UPDATE);
    Ok(())
}

/// Best-effort: keep the newest `lane.keep` generations of `path` IN THAT LANE
/// — `<file>.<suffix>*`, and for the quarantine the legacy un-suffixed `.bak`
/// too — and delete the rest. Scoped to one lane so a routine pre-update copy
/// can never evict a quarantine. The operation itself already succeeded; a
/// failing prune only logs.
fn prune_backups(path: &Path, lane: BackupLane) {
    let (Some(dir), Some(name)) = (
        path.parent(),
        path.file_name().map(|n| n.to_string_lossy().into_owned()),
    ) else {
        return;
    };
    let prefix = format!("{name}.{}", lane.suffix);
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut backups: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    backups.sort_by_key(|(modified, _)| Reverse(*modified)); // newest first
    for (_, old) in backups.into_iter().skip(lane.keep) {
        if let Err(e) = fs::remove_file(&old) {
            log::warn!("backup prune failed for {}: {e}", old.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{load, quarantine, save_atomic, snapshot, PRE_UPDATE, QUARANTINE};
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

    /// Every kept generation of `path` in ONE lane — the lanes are separate on
    /// disk, so a test that conflates them cannot see the eviction that
    /// separating them prevents.
    fn generations_of(path: &std::path::Path, suffix: &str) -> Vec<PathBuf> {
        let prefix = format!("{}.{suffix}", path.file_name().unwrap().to_string_lossy());
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
            .map(|e| e.path())
            .collect()
    }

    fn quarantines_of(path: &std::path::Path) -> Vec<PathBuf> {
        generations_of(path, QUARANTINE.suffix)
    }

    fn snapshots_of(path: &std::path::Path) -> Vec<PathBuf> {
        generations_of(path, PRE_UPDATE.suffix)
    }

    fn contents_of(paths: &[PathBuf]) -> Vec<String> {
        paths
            .iter()
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect()
    }

    #[test]
    fn quarantine_preserves_the_rejected_document() {
        let path = temp_deck();
        save_atomic(&path, "not json").unwrap();
        quarantine(&path).unwrap();

        assert_eq!(load(&path).unwrap(), None);
        let backups = quarantines_of(&path);
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

        let mut contents = contents_of(&quarantines_of(&path));
        contents.sort();
        assert_eq!(contents, vec!["first".to_string(), "second".to_string()]);
    }

    #[test]
    fn snapshot_copies_and_leaves_the_original_in_place() {
        let path = temp_deck();
        save_atomic(&path, "live").unwrap();
        snapshot(&path).unwrap();

        // Unlike the quarantine, the document the app is using stays put.
        assert_eq!(load(&path).unwrap().as_deref(), Some("live"));
        let backups = snapshots_of(&path);
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), "live");
        // And it lands in its OWN lane, never among the quarantines.
        assert!(quarantines_of(&path).is_empty());
    }

    #[test]
    fn snapshot_of_a_missing_document_is_a_no_op() {
        // The real shape of this case: the home exists, the document does not
        // (a first run). Nothing to keep is not a failure — it must never block
        // the update the user asked for.
        let path = temp_deck();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        snapshot(&path).unwrap();
        assert!(snapshots_of(&path).is_empty());
    }

    #[test]
    fn a_quarantine_survives_any_number_of_snapshots() {
        // The two lanes used to share one 5-slot rotation pruned by age, so a
        // user who took five updates after a corrupt settings file lost the
        // evidence — the very thing the quarantine exists to keep, deleted by
        // the very feature added to preserve their settings.
        let path = temp_deck();
        save_atomic(&path, "REJECTED").unwrap();
        quarantine(&path).unwrap();

        for i in 0..(QUARANTINE.keep + PRE_UPDATE.keep + 3) {
            save_atomic(&path, &format!("update-{i}")).unwrap();
            snapshot(&path).unwrap();
        }

        assert_eq!(contents_of(&quarantines_of(&path)), vec!["REJECTED".to_string()]);
    }

    #[test]
    fn snapshots_rotate_within_their_own_lane() {
        let path = temp_deck();
        for i in 0..(PRE_UPDATE.keep + 2) {
            save_atomic(&path, &format!("gen-{i}")).unwrap();
            snapshot(&path).unwrap();
        }
        let kept = snapshots_of(&path);
        assert_eq!(kept.len(), PRE_UPDATE.keep);
        // The newest copy always survives — it is the one a restore wants.
        assert!(contents_of(&kept).contains(&format!("gen-{}", PRE_UPDATE.keep + 1)));
    }

    #[test]
    fn prune_keeps_only_the_newest_generations() {
        let path = temp_deck();
        for i in 0..(QUARANTINE.keep + 2) {
            save_atomic(&path, &format!("gen-{i}")).unwrap();
            quarantine(&path).unwrap();
        }
        let backups = quarantines_of(&path);
        assert_eq!(backups.len(), QUARANTINE.keep);
        // The newest generation always survives.
        assert!(contents_of(&backups).contains(&format!("gen-{}", QUARANTINE.keep + 1)));
    }

    #[test]
    fn legacy_unsuffixed_bak_counts_toward_the_limit() {
        let path = temp_deck();
        save_atomic(&path.with_extension("json.bak"), "legacy").unwrap();
        for i in 0..QUARANTINE.keep {
            save_atomic(&path, &format!("gen-{i}")).unwrap();
            quarantine(&path).unwrap();
        }
        // legacy + QUARANTINE.keep new ones → pruned back to the limit, and the
        // legacy file (oldest by mtime) is what went.
        let backups = quarantines_of(&path);
        assert_eq!(backups.len(), QUARANTINE.keep);
        assert!(!path.with_extension("json.bak").exists());
    }

    #[test]
    fn quarantine_of_a_missing_file_is_a_no_op() {
        assert!(quarantine(&temp_deck()).is_ok());
    }
}
