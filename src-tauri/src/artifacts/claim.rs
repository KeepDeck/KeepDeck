//! Owning the artifacts STORE ROOT.
//!
//! One question, answered before anything writes: may this process own
//! `data_dir/artifacts`. The mutation mutex serializes threads WITHIN one
//! process; concurrent KeepDeck instances are a real state (dev build
//! beside the bundled app — `crate::logging` designs for it), and a
//! in-process mutex does not cross processes. Hence this flock-backed
//! claim, mirroring [`crate::mcp::server::claim`]'s shape and constants:
//! same 250ms/5ms wait/retry loop (fork-inheritance patience — every
//! PTY agent and git child inherits descriptors across fork and keeps a
//! just-released lock alive until it execs), same contention≠fault
//! discipline. The one difference: the root is a DIRECTORY we create, so
//! there is no stale-name unlink/probe dance.
//!
//! Copy-with-adaptation, not import: `claim()` is `pub(super)` there and
//! its error text names the socket. Extraction to a shared `fs_claim`
//! module is a follow-up, not a blocker.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The lock file that makes ownership of the store root exclusive.
const LOCK_FILE: &str = "lock";

const CLAIM_TIMEOUT: Duration = Duration::from_millis(250);
const CLAIM_RETRY: Duration = Duration::from_millis(5);

/// Take the exclusive claim on the artifacts root: create the root, open
/// the lock file, flock it. Contention and failure are DIFFERENT answers
/// (another instance's claim is a refusal the user can act on; a failed
/// lock call is a fault that must say what it was), and an interrupted
/// call is retried — `flock(2)` is interruptible.
pub(super) fn claim(root: &Path) -> Result<ClaimedRoot, String> {
    std::fs::create_dir_all(root)
        .map_err(|e| format!("creating artifact store root failed: {e}"))?;
    let lock_path: PathBuf = root.join(LOCK_FILE);
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("opening {} failed: {e}", lock_path.display()))?;
    let deadline = std::time::Instant::now() + CLAIM_TIMEOUT;
    loop {
        match lock.try_lock() {
            Ok(()) => {
                return Ok(ClaimedRoot {
                    _lock: lock,
                    root: root.to_path_buf(),
                })
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    return Err(
                        "artifact store is owned by another KeepDeck process".into(),
                    );
                }
                std::thread::sleep(CLAIM_RETRY);
            }
            Err(std::fs::TryLockError::Error(e))
                if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(std::fs::TryLockError::Error(e)) => {
                return Err(format!("claiming the artifact store failed: {e}"));
            }
        }
    }
}

/// The owned root. Dropping the guard releases the kernel lock — the
/// enabled state holds it for the feature's whole On life.
#[derive(Debug)]
pub(super) struct ClaimedRoot {
    _lock: File,
    root: PathBuf,
}

impl ClaimedRoot {
    /// The owned root path.
    pub(super) fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("artifacts");
        (dir, root)
    }

    #[test]
    fn a_claim_creates_the_root_and_succeeds() {
        let (_dir, root) = temp_root();
        let claimed = claim(&root).expect("first claim");
        assert!(claimed.root().is_dir());
        assert!(root.join(LOCK_FILE).exists());
    }

    #[test]
    fn a_claim_a_holder_keeps_is_refused_as_contention() {
        let (_dir, root) = temp_root();
        let _holder = claim(&root).expect("holder claim");
        let refused = claim(&root).expect_err("second claim must be refused");
        assert!(
            refused.contains("another KeepDeck process"),
            "refusal text: {refused}"
        );
    }

    #[test]
    fn releasing_the_guard_frees_the_claim() {
        let (_dir, root) = temp_root();
        {
            let _held = claim(&root).expect("held claim");
        }
        // Fork-inheritance patience aside (no forked children here), a
        // dropped guard must free the claim for the next enable.
        let reclaimed = claim(&root).expect("re-claim after drop");
        drop(reclaimed);
    }
}
