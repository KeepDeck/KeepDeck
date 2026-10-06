//! Backups of the task database: consistent copies taken while it is in
//! use, kept in `backups/` beside it, the latest three.
//!
//! Three rules make "never rotate away the last good copy" true by
//! construction: a copy enters the set only after it has itself passed
//! the check; only a NEWER verified copy can push the oldest out; and a
//! session that has seen damage takes no copy at all (the store's job —
//! a copy of a damaged database would launder the damage into a good slot).

use std::path::{Path, PathBuf};

use diesel::prelude::*;
use diesel::sql_types::Text;

use crate::db;
use crate::error::{Result, StoreError};

pub const BACKUP_DIR: &str = "backups";
pub const BACKUPS_KEPT: usize = 3;
/// A backup is due when the newest is older than this and the boards changed.
pub const BACKUP_EVERY_MS: i64 = 60 * 60 * 1000;

const PREFIX: &str = "tasks-";
const SUFFIX: &str = ".db";
/// The name a copy taken before a schema step starts with (`take_before`).
const PRE_STEP: &str = "tasks-pre-";

/// The copies taken before schema steps that are in `dir` — a half-written
/// `.tmp` is none.
pub fn copies_before(dir: &Path) -> Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(StoreError::Io { detail: format!("reading {}: {e}", dir.display()) }),
    };
    Ok(entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with(PRE_STEP) && name.ends_with(SUFFIX)
        })
        .map(|entry| entry.path())
        .collect())
}

/// One verified backup, newest first in every list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backup {
    pub path: PathBuf,
    /// When it was taken, ms since the epoch — its name.
    pub at: i64,
}

/// The backups in `dir`, newest first. A file that is not one of ours —
/// including a half-written `.tmp` — is not a backup.
pub fn list(dir: &Path) -> Result<Vec<Backup>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(StoreError::Io { detail: format!("reading {}: {e}", dir.display()) }),
    };
    let mut backups: Vec<Backup> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let at = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?.parse::<i64>().ok()?;
            Some(Backup { path: entry.path(), at })
        })
        .collect();
    backups.sort_by_key(|backup| std::cmp::Reverse(backup.at));
    Ok(backups)
}

/// Whether a backup is due: none yet, or the newest older than an hour
/// while the boards changed since. A newest taken "in the future" — the
/// clock was ahead then — is no reason to wait: due on any change.
pub fn due(dir: &Path, now_ms: i64, changed: bool) -> Result<bool> {
    Ok(match list(dir)?.first() {
        None => true,
        Some(newest) => changed && (newest.at > now_ms || now_ms - newest.at >= BACKUP_EVERY_MS),
    })
}

/// Take a backup of the database at `db_path` — on a connection of its own,
/// so the store's writes are never held up — verify it, and only then let
/// it into the set of three.
pub fn take(db_path: &Path, dir: &Path, now_ms: i64) -> Result<Backup> {
    let tmp = snapshot(db_path, dir, &format!("{PREFIX}{now_ms}{SUFFIX}"))?;
    admit(&tmp, dir, now_ms)
}

/// The copy taken before the schema step `migration`: the database as the
/// step found it — the way back if the step goes wrong. Its own name
/// (`tasks-pre-<step>.db`), outside the set of three — never rotated
/// away, never offered as an hourly backup — and taken once per step: a
/// step that fails again finds its copy there and takes no second. A copy
/// found there is checked first. One found damaged is no way back, and
/// goes — the step has not run, so the database is still as it found it,
/// and a fresh copy is the same copy; one that cannot be checked now (held
/// by another opener, the disk refusing) is kept as it is, and the open
/// waits for it, answering why.
pub fn take_before(db_path: &Path, dir: &Path, migration: &str) -> Result<PathBuf> {
    let path = dir.join(format!("{PRE_STEP}{migration}{SUFFIX}"));
    if path.exists() {
        match check(&path) {
            Ok(()) => return Ok(path),
            Err(StoreError::Corrupt { .. }) => {
                let _ = std::fs::remove_file(&path);
            }
            Err(other) => return Err(other),
        }
    }
    let tmp = snapshot(db_path, dir, &format!("{PRE_STEP}{migration}{SUFFIX}"))?;
    verify(&tmp)?;
    std::fs::rename(&tmp, &path).map_err(|e| StoreError::Io { detail: format!("placing the copy: {e}") })?;
    Ok(path)
}

/// A consistent copy of the database at `db_path`, written beside `name`
/// in `dir` as a `.tmp` — on a connection of its own, so the store's
/// writes are never held up. Not yet checked: what it becomes is the
/// caller's, once it passes (`verify`).
fn snapshot(db_path: &Path, dir: &Path, name: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|e| StoreError::Io { detail: format!("creating {}: {e}", dir.display()) })?;
    let tmp = dir.join(format!("{name}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    let mut source = db::open_read_only(db_path)?;
    diesel::sql_query("VACUUM INTO ?").bind::<Text, _>(tmp.to_string_lossy().into_owned()).execute(&mut source)?;
    drop(source);
    Ok(tmp)
}

/// Whether a copy passes the check — damaged (Corrupt), or not checkable
/// now (Busy, Io) said apart.
fn check(copy: &Path) -> Result<()> {
    db::open_read_only(copy).and_then(|mut conn| db::quick_check(&mut conn))
}

/// Whether a candidate copy just written passes the check — and, when it
/// does not, it is removed: a copy this store wrote and cannot vouch for is
/// never kept as one.
fn verify(candidate: &Path) -> Result<()> {
    let verified = check(candidate);
    if verified.is_err() {
        let _ = std::fs::remove_file(candidate);
    }
    verified
}

/// Let a candidate copy into the set — only once it has passed the check
/// itself. A candidate that fails is removed and the set is untouched:
/// the oldest good copy is never pushed out by a bad one.
pub fn admit(candidate: &Path, dir: &Path, at: i64) -> Result<Backup> {
    verify(candidate)?;
    let path = dir.join(format!("{PREFIX}{at}{SUFFIX}"));
    std::fs::rename(candidate, &path).map_err(|e| StoreError::Io { detail: format!("placing the backup: {e}") })?;
    rotate(dir, at)?;
    Ok(Backup { path, at })
}

/// Keep the newest three; the rest go. One named after `now` — taken by a
/// clock that was ahead — is the first to go, never kept as "newest".
fn rotate(dir: &Path, now_ms: i64) -> Result<()> {
    let mut backups = list(dir)?;
    backups.sort_by_key(|backup| (backup.at > now_ms, std::cmp::Reverse(backup.at)));
    for old in backups.into_iter().skip(BACKUPS_KEPT) {
        std::fs::remove_file(&old.path)
            .map_err(|e| StoreError::Io { detail: format!("removing an old backup: {e}") })?;
    }
    Ok(())
}

/// The backups that pass the check now, newest first — what the person is
/// offered to restore from. One that fails is left on disk and not offered.
pub fn verified(dir: &Path) -> Result<Vec<Backup>> {
    Ok(list(dir)?
        .into_iter()
        .filter(|backup| db::open_read_only(&backup.path).and_then(|mut c| db::quick_check(&mut c)).is_ok())
        .collect())
}
