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
//!
//! A run also names the bridge's socket, beside its directory rather than in
//! it: `<root>/<id>` for the run `run-<id>`. Beside, because a unix socket's
//! path is short — 104 bytes on macOS — and a run's directory is already
//! deep. Its own per run, because the leftovers of an earlier run — a
//! daemon some agent started, its workers, all still holding the old
//! environment — must post into nothing, as they did to an old port, and
//! never reach the door of the run after. A run's socket is swept with it.

use std::fs::{self, File};
use std::path::{Path, PathBuf};

/// The staging area run dirs are built (and locked) in before publication.
const STAGING_DIR: &str = ".staging";

/// The lock file a live instance holds inside its run dir.
const LOCK_FILE: &str = "lock";

/// The root-wide lock serializing boot (sweep + publish) across instances.
const BOOT_LOCK: &str = ".boot-lock";

/// What a run's directory is named: this, then its id.
const RUN_PREFIX: &str = "run-";

/// How many hex digits a run's id has. Five make `<home>/bridge/<id>` exactly
/// as long past the home as the MCP socket's `<home>/mcp/mcp.sock`, so a home
/// whose path leaves room for one leaves room for the other.
const RUN_ID_LEN: usize = 5;

/// One run of the bridge: its directory, the path of its socket, and the
/// lock that keeps both its own.
pub(super) struct Run {
    pub(super) dir: PathBuf,
    pub(super) socket: PathBuf,
    pub(super) lock: File,
}

/// Owner-only permissions — other users never see it. Best-effort:
/// the home is usually 0700 already.
pub(super) fn restrict(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
}

/// Sweep, then publish this run's directory — under a root-wide boot lock, so
/// the two are one atomic step ACROSS instances. The per-run lock cannot
/// cover the moment before it exists (a dir is created before its lock
/// file), which is exactly the window where a concurrently booting sweeper
/// could eat a sibling's half-built staging dir. The gate is held for
/// microseconds and the kernel releases it even on a crash. Expects `root`
/// to exist.
pub(super) fn boot(root: &Path) -> Result<(Run, usize), String> {
    let gate = File::create(root.join(BOOT_LOCK)).map_err(|e| e.to_string())?;
    gate.lock()
        .map_err(|e| format!("bridge boot lock failed: {e:?}"))?;
    let swept = sweep_orphans(root);
    let run = create_run_dir(root)?;
    Ok((run, swept))
    // `gate` drops here — boot section over, the next instance may proceed.
}

/// Build this run's directory under `.staging/`, take its lock THERE, then
/// atomically rename it into the root. Publication happens already-locked,
/// so a sweeper OUTSIDE the boot gate (there are none today — sweeping only
/// happens inside `boot`) could still never mistake a published live run dir
/// for an orphan.
///
/// Its id is one no run in the root holds, and no file either — a live
/// sibling's socket, or a leftover the sweep could not remove.
fn create_run_dir(root: &Path) -> Result<Run, String> {
    let staging = root.join(STAGING_DIR);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let id = loop {
        let id = uuid::Uuid::new_v4().simple().to_string()[..RUN_ID_LEN].to_string();
        let taken = |path: PathBuf| fs::symlink_metadata(path).is_ok();
        if !taken(root.join(format!("{RUN_PREFIX}{id}"))) && !taken(root.join(&id)) {
            break id;
        }
    };
    let name = format!("{RUN_PREFIX}{id}");
    let staged = staging.join(&name);
    fs::create_dir(&staged).map_err(|e| e.to_string())?;
    restrict(&staged);
    let lock = File::create(staged.join(LOCK_FILE)).map_err(|e| e.to_string())?;
    lock.try_lock()
        .map_err(|e| format!("locking a fresh run dir failed: {e:?}"))?;
    let dir = root.join(&name);
    fs::rename(&staged, &dir).map_err(|e| e.to_string())?;
    Ok(Run { dir, socket: root.join(id), lock })
}

/// Whether `name`, in the root, is what a run's socket is named.
fn is_socket_name(name: &str) -> bool {
    name.len() == RUN_ID_LEN && name.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Delete run dirs whose owners are gone, in the root and in `.staging`, and
/// every run's socket whose run is gone with them. Returns how many run dirs
/// were swept.
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
    // A socket whose run is not published — swept just now, or never made
    // whole — is a leftover nothing answers on.
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str().filter(|name| is_socket_name(name)) else { continue };
            if !entry.path().is_dir() && !root.join(format!("{RUN_PREFIX}{name}")).is_dir() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    swept
}

/// A dir is an orphan when nobody holds its lock. A live owner ALWAYS holds
/// one (taken before publication); the kernel releases it on any process
/// death. Busy — or unprobeable — locks leave the dir alone: deleting a live
/// instance's run dir is the one unacceptable failure mode.
fn is_orphan(dir: &Path) -> bool {
    match File::open(dir.join(LOCK_FILE)) {
        // No lock file at all: a torn boot's leftovers (the rename that
        // publishes a live run dir only ever runs after its lock exists).
        Err(_) => true,
        Ok(file) => file.try_lock().is_ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_run_dir_is_published_locked_with_empty_staging() {
        let root = tempfile::tempdir().unwrap();
        let Run { dir, socket, lock: _lock } = create_run_dir(root.path()).unwrap();
        assert!(
            dir.parent().unwrap() == root.path(),
            "published into the root"
        );
        assert!(dir.join(LOCK_FILE).is_file());
        // Its socket sits beside it, named by its id, no longer past the
        // root than `mcp/mcp.sock` past the home.
        let id = socket.file_name().unwrap().to_str().unwrap();
        assert_eq!(socket.parent().unwrap(), root.path());
        assert!(is_socket_name(id), "{id}");
        assert_eq!(dir.file_name().unwrap().to_str().unwrap(), format!("{RUN_PREFIX}{id}"));
        assert_eq!(format!("bridge/{id}").len(), "mcp/mcp.sock".len());
        // The staging area kept nothing behind.
        let staged: Vec<_> = fs::read_dir(root.path().join(STAGING_DIR))
            .unwrap()
            .collect();
        assert!(staged.is_empty());
        // And the lock is genuinely held: a probe must NOT call it an orphan.
        assert!(!is_orphan(&dir));
    }

    #[test]
    fn sweep_removes_dead_run_dirs_and_spares_live_ones() {
        let root = tempfile::tempdir().unwrap();
        // A live run dir: lock held by this process, and its socket.
        let live = create_run_dir(root.path()).unwrap();
        fs::write(&live.socket, "").unwrap();
        // A dead run dir: lock file exists but nobody holds it, and the
        // socket its run left behind.
        let dead = root.path().join("run-dead0");
        fs::create_dir(&dead).unwrap();
        File::create(dead.join(LOCK_FILE)).unwrap();
        let dead_socket = root.path().join("dead0");
        fs::write(&dead_socket, "").unwrap();
        // A socket whose run never made it into the root.
        let lone_socket = root.path().join("0a1b2");
        fs::write(&lone_socket, "").unwrap();
        // A torn staging leftover: no lock file was ever created.
        let torn = root.path().join(STAGING_DIR).join("run-torn");
        fs::create_dir_all(&torn).unwrap();
        // A stray file in the root must simply be skipped, and so must one
        // that is no socket's name.
        fs::write(root.path().join("stray.txt"), "x").unwrap();
        fs::write(root.path().join("ABCDE"), "x").unwrap();

        assert_eq!(sweep_orphans(root.path()), 2);
        assert!(live.dir.is_dir(), "live run dir survives");
        assert!(live.socket.exists(), "and so does its socket");
        assert!(!dead.exists(), "dead run dir swept");
        assert!(!dead_socket.exists(), "with its socket");
        assert!(!lone_socket.exists(), "a socket of no run swept");
        assert!(!torn.exists(), "torn staging leftover swept");
        assert!(root.path().join("stray.txt").is_file());
        assert!(root.path().join("ABCDE").is_file());
    }

    #[test]
    fn concurrent_boots_never_eat_each_other() {
        // Regression for the boot race: a sweeping instance must never
        // observe (and delete) a sibling's half-built staging dir. The boot
        // gate serializes sweep+publish, so every one of these succeeds and
        // every published run dir stays alive.
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
        for (run, _swept) in &live {
            assert!(run.dir.is_dir(), "published run dir survives: {}", run.dir.display());
            assert!(!is_orphan(&run.dir));
        }
        let sockets: std::collections::HashSet<_> = live.iter().map(|(run, _)| &run.socket).collect();
        assert_eq!(sockets.len(), 8, "every run names a socket of its own");
    }
}
