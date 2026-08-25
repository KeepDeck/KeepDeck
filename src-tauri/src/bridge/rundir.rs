//! The run directory's life: minting one, holding its lock, and reaping the
//! ones whose owners are gone.
//!
//! Filesystem and OS locks only — it never learns what travels through the
//! directory it makes. It was named `inbox` while envelopes arrived as files
//! in it; nothing arrives here any more, and what is left is the lifecycle
//! that was always a separate concern from the transport riding on it.
//!
//! Per-run dirs mean two KeepDeck instances never share one. Orphans from
//! crashed runs are swept at boot by probing their locks: the kernel releases
//! a dead process's lock unconditionally, so "lock acquirable" == "owner
//! dead" — no PID files, no age heuristics. A new one is built under
//! `.staging/` and lock-acquired BEFORE the atomic rename publishes it, so a
//! concurrently booting sweeper can never catch a live directory unlocked.

use std::fs::{self, File};
use std::path::{Path, PathBuf};

/// The staging area run dirs are built (and locked) in before publication.
const STAGING_DIR: &str = ".staging";

/// The lock file a live instance holds inside its run dir.
const LOCK_FILE: &str = "lock";

/// The root-wide lock serializing boot (sweep + publish) across instances.
const BOOT_LOCK: &str = ".boot-lock";

/// Owner-only permissions — other users never see it. Best-effort:
/// the home is usually 0700 already.
pub(super) fn restrict(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
}

/// Sweep, then publish this run's inbox — under a root-wide boot lock, so
/// the two are one atomic step ACROSS instances. The per-inbox lock cannot
/// cover the moment before it exists (a dir is created before its lock
/// file), which is exactly the window where a concurrently booting sweeper
/// could eat a sibling's half-built staging dir. The gate is held for
/// microseconds and the kernel releases it even on a crash. Expects `root`
/// to exist.
pub(super) fn boot(root: &Path) -> Result<(PathBuf, File, usize), String> {
    let gate = File::create(root.join(BOOT_LOCK)).map_err(|e| e.to_string())?;
    gate.lock()
        .map_err(|e| format!("bridge boot lock failed: {e:?}"))?;
    let swept = sweep_orphans(root);
    let (run_dir, lock) = create_run_dir(root)?;
    Ok((run_dir, lock, swept))
    // `gate` drops here — boot section over, the next instance may proceed.
}

/// Build this run's inbox under `.staging/`, take its lock THERE, then
/// atomically rename it into the root. Publication happens already-locked,
/// so a sweeper OUTSIDE the boot gate (there are none today — sweeping only
/// happens inside `boot`) could still never mistake a published live inbox
/// for an orphan.
fn create_run_dir(root: &Path) -> Result<(PathBuf, File), String> {
    let staging = root.join(STAGING_DIR);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let name = format!("run-{}", uuid::Uuid::new_v4());
    let staged = staging.join(&name);
    fs::create_dir(&staged).map_err(|e| e.to_string())?;
    restrict(&staged);
    let lock = File::create(staged.join(LOCK_FILE)).map_err(|e| e.to_string())?;
    lock.try_lock()
        .map_err(|e| format!("locking a fresh inbox failed: {e:?}"))?;
    let run_dir = root.join(&name);
    fs::rename(&staged, &run_dir).map_err(|e| e.to_string())?;
    Ok((run_dir, lock))
}

/// Delete inboxes whose owners are gone, in the root and in `.staging`.
/// Returns how many were swept.
fn sweep_orphans(root: &Path) -> usize {
    let mut swept = 0;
    for base in [root.to_path_buf(), root.join(STAGING_DIR)] {
        let Ok(entries) = fs::read_dir(&base) else {
            continue;
        };
        // Only dirs are probed — the boot-lock FILE at the root is skipped
        // by the is_dir check below.
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || path.file_name().is_some_and(|n| n == STAGING_DIR) {
                continue;
            }
            if is_orphan(&path) && fs::remove_dir_all(&path).is_ok() {
                swept += 1;
            }
        }
    }
    swept
}

/// A dir is an orphan when nobody holds its lock. A live owner ALWAYS holds
/// one (taken before publication); the kernel releases it on any process
/// death. Busy — or unprobeable — locks leave the dir alone: deleting a live
/// instance's inbox is the one unacceptable failure mode.
fn is_orphan(dir: &Path) -> bool {
    match File::open(dir.join(LOCK_FILE)) {
        // No lock file at all: a torn boot's leftovers (the rename that
        // publishes a live inbox only ever runs after its lock exists).
        Err(_) => true,
        Ok(file) => file.try_lock().is_ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_inbox_is_published_locked_with_empty_staging() {
        let root = tempfile::tempdir().unwrap();
        let (dir, _lock) = create_run_dir(root.path()).unwrap();
        assert!(
            dir.parent().unwrap() == root.path(),
            "published into the root"
        );
        assert!(dir.join(LOCK_FILE).is_file());
        // The staging area kept nothing behind.
        let staged: Vec<_> = fs::read_dir(root.path().join(STAGING_DIR))
            .unwrap()
            .collect();
        assert!(staged.is_empty());
        // And the lock is genuinely held: a probe must NOT call it an orphan.
        assert!(!is_orphan(&dir));
    }

    #[test]
    fn sweep_removes_dead_inboxes_and_spares_live_ones() {
        let root = tempfile::tempdir().unwrap();
        // A live inbox: lock held by this process.
        let (live, _held) = create_run_dir(root.path()).unwrap();
        // A dead inbox: lock file exists but nobody holds it.
        let dead = root.path().join("run-dead");
        fs::create_dir(&dead).unwrap();
        File::create(dead.join(LOCK_FILE)).unwrap();
        // A torn staging leftover: no lock file was ever created.
        let torn = root.path().join(STAGING_DIR).join("run-torn");
        fs::create_dir_all(&torn).unwrap();
        // A stray file in the root must simply be skipped.
        fs::write(root.path().join("stray.txt"), "x").unwrap();

        assert_eq!(sweep_orphans(root.path()), 2);
        assert!(live.is_dir(), "live inbox survives");
        assert!(!dead.exists(), "dead inbox swept");
        assert!(!torn.exists(), "torn staging leftover swept");
        assert!(root.path().join("stray.txt").is_file());
    }

    #[test]
    fn concurrent_boots_never_eat_each_other() {
        // Regression for the boot race: a sweeping instance must never
        // observe (and delete) a sibling's half-built staging dir. The boot
        // gate serializes sweep+publish, so every one of these succeeds and
        // every published inbox stays alive.
        let root = tempfile::tempdir().unwrap();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let root = root.path().to_path_buf();
                std::thread::spawn(move || boot(&root))
            })
            .collect();
        let live: Vec<_> = handles
            .into_iter()
            .map(|h| h.join().unwrap().expect("every boot succeeds"))
            .collect();
        assert_eq!(live.len(), 8);
        for (dir, _lock, _swept) in &live {
            assert!(dir.is_dir(), "published inbox survives: {}", dir.display());
            assert!(!is_orphan(dir));
        }
    }
}
