//! Owning a feature's STORE ROOT on disk — the flock-backed claim the
//! artifacts store, the task board and the lifecycle journal take before
//! anything writes.
//!
//! One question, answered before anything writes: may this process own
//! this root. A mutation mutex serializes threads WITHIN one process; an
//! in-process mutex does not cross processes, and two processes on one
//! root are a real state — a build started beside another, or the copy a
//! restart spawns before the old one is gone. Hence this flock, mirroring
//! the unix door's claim (`crate::unix_door::claim`) — its shape and constants: same 5ms retry and,
//! for the stores, the same 250ms wait (fork-inheritance patience — every
//! PTY agent and git child inherits descriptors across fork and keeps a
//! just-released lock alive until it execs), same contention≠fault
//! discipline. The one difference: the root is a DIRECTORY we create, so
//! there is no stale-name unlink/probe dance.
//!
//! The holder names itself in the lock file: one line, its pid and whether
//! it is leaving (`keepdeck_lifecycle::domain::single`). flock bars no
//! reader, so a process kept out can read who keeps it out.
//!
//! `what` names the store in every refusal ("artifact store", "task
//! board") — the sentence reaches the user through the toggle, and a
//! claim that spoke of the wrong feature would send them to the wrong
//! switch.

use keepdeck_lifecycle::domain::single::{lock_line, parse_lock_line, Holder, ORDINARY_PATIENCE};
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The lock file that makes ownership of the store root exclusive. A store
/// that reads its root's files is told this name, so as to leave it be.
pub(crate) const LOCK_FILE: &str = "lock";

const CLAIM_RETRY: Duration = Duration::from_millis(5);

/// The step of a claim that failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    MakeRoot,
    OpenLock,
    Lock,
}

/// Why a claim was not had. Contention and failure are DIFFERENT answers:
/// another process's claim is a refusal the person can act on; a failed
/// call is a fault that must say what it was.
#[derive(Debug)]
pub(crate) enum Refusal {
    /// Another process holds the root: what its lock said when the wait ran
    /// out — nothing, for a holder that does not name itself.
    Held { holder: Option<Holder> },
    /// The root could not be owned.
    Fault { step: Step, error: std::io::Error },
}

/// Take the exclusive claim on a store root, waiting `patience` for a
/// holder to let go: create the root, open the lock file, flock it, then
/// name ourselves in it. An interrupted call is retried — `flock(2)` is
/// interruptible.
pub(crate) fn claim_within(root: &Path, patience: Duration) -> Result<ClaimedRoot, Refusal> {
    std::fs::create_dir_all(root).map_err(|error| Refusal::Fault { step: Step::MakeRoot, error })?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(LOCK_FILE))
        .map_err(|error| Refusal::Fault { step: Step::OpenLock, error })?;
    let deadline = Instant::now() + patience;
    loop {
        match lock.try_lock() {
            Ok(()) => {
                let claimed = ClaimedRoot { lock, root: root.to_path_buf() };
                claimed.name_holder(false);
                return Ok(claimed);
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(Refusal::Held { holder: holder(root) });
                }
                std::thread::sleep(CLAIM_RETRY);
            }
            Err(std::fs::TryLockError::Error(error)) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(std::fs::TryLockError::Error(error)) => return Err(Refusal::Fault { step: Step::Lock, error }),
        }
    }
}

/// The stores' claim: the ordinary patience, and every refusal the
/// sentence the store's toggle shows.
pub(crate) fn claim(root: &Path, what: &str) -> Result<ClaimedRoot, String> {
    claim_within(root, ORDINARY_PATIENCE).map_err(|refusal| match refusal {
        Refusal::Held { .. } => format!("{what} is owned by another KeepDeck process"),
        Refusal::Fault { step: Step::MakeRoot, error } => format!("creating the {what} root failed: {error}"),
        Refusal::Fault { step: Step::OpenLock, error } => {
            format!("opening {} failed: {error}", root.join(LOCK_FILE).display())
        }
        Refusal::Fault { step: Step::Lock, error } => format!("claiming the {what} failed: {error}"),
    })
}

/// Who holds `root`, as its lock says — `None` when nothing does, or when
/// the holder does not name itself.
pub(crate) fn holder(root: &Path) -> Option<Holder> {
    parse_lock_line(&std::fs::read_to_string(root.join(LOCK_FILE)).ok()?)
}

/// The owned root. Dropping the guard releases the kernel lock — the
/// enabled state holds it for the feature's whole On life.
#[derive(Debug)]
pub(crate) struct ClaimedRoot {
    lock: File,
    root: PathBuf,
}

impl ClaimedRoot {
    /// The owned root path.
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// This holder was asked to restart: the lock says so from now on, for
    /// the copy that is to replace it.
    pub(crate) fn set_leaving(&self) {
        self.name_holder(true);
    }

    /// Write this process's line over whatever the lock held. Best effort: a
    /// lock that names nobody still keeps everyone else out, and a reader
    /// takes it for a holder that does not name itself.
    fn name_holder(&self, leaving: bool) {
        let line = lock_line(Holder { pid: std::process::id(), leaving });
        let mut file = &self.lock;
        let written = file
            .seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(line.as_bytes()))
            // Past the line is what a longer one left — nothing a build of
            // this line's width writes, but whatever else wrote there.
            .and_then(|()| file.set_len(line.len() as u64));
        if let Err(error) = written {
            log::warn!("naming this process in {} failed: {error}", self.root.join(LOCK_FILE).display());
        }
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

    fn us(leaving: bool) -> Option<Holder> {
        Some(Holder { pid: std::process::id(), leaving })
    }

    #[test]
    fn a_claim_creates_the_root_and_succeeds() {
        let (_dir, root) = temp_root();
        let claimed = claim(&root, "artifact store").expect("first claim");
        assert!(claimed.root().is_dir());
        assert!(root.join(LOCK_FILE).exists());
    }

    #[test]
    fn a_claim_a_holder_keeps_is_refused_as_contention() {
        let (_dir, root) = temp_root();
        let _holder = claim(&root, "artifact store").expect("holder claim");
        let started = Instant::now();
        let refused = claim(&root, "artifact store").expect_err("second claim must be refused");
        assert_eq!(refused, "artifact store is owned by another KeepDeck process");
        // A store's toggle answers within the ordinary patience, not after a
        // replacing copy's long wait.
        assert!(started.elapsed() < Duration::from_secs(2), "refused after {:?}", started.elapsed());
    }

    #[test]
    fn releasing_the_guard_frees_the_claim() {
        let (_dir, root) = temp_root();
        {
            let _held = claim(&root, "artifact store").expect("held claim");
        }
        // Fork-inheritance patience aside (no forked children here), a
        // dropped guard must free the claim for the next enable.
        let reclaimed = claim(&root, "artifact store").expect("re-claim after drop");
        drop(reclaimed);
    }

    #[test]
    fn the_lock_names_the_process_that_holds_it() {
        let (_dir, root) = temp_root();
        let _held = claim_within(&root, ORDINARY_PATIENCE).expect("claim");
        assert_eq!(holder(&root), us(false));
    }

    #[test]
    fn a_claim_over_an_older_longer_line_names_the_new_holder() {
        let (_dir, root) = temp_root();
        std::fs::create_dir_all(&root).unwrap();
        let older = format!("{} and more an older writer left", lock_line(Holder { pid: 4_000_000_000, leaving: true }));
        std::fs::write(root.join(LOCK_FILE), older).unwrap();
        let _held = claim_within(&root, ORDINARY_PATIENCE).expect("claim");
        assert_eq!(holder(&root), us(false));
    }

    #[test]
    fn a_holder_keeps_a_contender_out_for_the_patience_given_and_no_longer() {
        let (_dir, root) = temp_root();
        let _held = claim_within(&root, ORDINARY_PATIENCE).expect("holder");
        let started = Instant::now();
        let refused = claim_within(&root, Duration::from_millis(300)).expect_err("held");
        let waited = started.elapsed();
        assert!(matches!(refused, Refusal::Held { holder } if holder == us(false)), "{refused:?}");
        assert!(waited >= Duration::from_millis(300), "gave up after {waited:?}");
        assert!(waited < Duration::from_secs(2), "waited {waited:?}");
    }

    #[test]
    fn a_lock_released_inside_the_patience_is_taken() {
        let (_dir, root) = temp_root();
        let held = claim_within(&root, ORDINARY_PATIENCE).expect("holder");
        let letting_go = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(held);
        });
        let taken = claim_within(&root, Duration::from_secs(5));
        letting_go.join().unwrap();
        assert!(taken.is_ok(), "{:?}", taken.err());
    }

    #[test]
    fn a_root_that_cannot_be_made_is_a_fault_not_a_holder() {
        let (dir, _) = temp_root();
        let file = dir.path().join("a-file");
        std::fs::write(&file, "").unwrap();
        let refused = claim_within(&file.join("root"), ORDINARY_PATIENCE).expect_err("no root under a file");
        assert!(matches!(refused, Refusal::Fault { step: Step::MakeRoot, .. }), "{refused:?}");
    }

    #[test]
    fn leaving_replaces_running_in_place() {
        let (_dir, root) = temp_root();
        let held = claim_within(&root, ORDINARY_PATIENCE).expect("claim");
        let length = std::fs::metadata(root.join(LOCK_FILE)).unwrap().len();
        held.set_leaving();
        assert_eq!(holder(&root), us(true));
        assert_eq!(std::fs::metadata(root.join(LOCK_FILE)).unwrap().len(), length);
    }
}
