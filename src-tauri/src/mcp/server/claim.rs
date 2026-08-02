//! Owning the socket NAME.
//!
//! One question, answered before anything binds: may this process serve at
//! this path. `bind(2)` alone cannot arbitrate it — the stale-socket cleanup
//! unlinks the name first, so two instances interleaving there would each
//! remove the other's socket — hence an flock-backed claim.
//!
//! Whether the DIRECTORY it would serve from is ours is a different question
//! with a different reason to change (the permission model), and lives in
//! [`super::socket_dir`].

use std::fs::File;
use std::path::Path;
use std::time::Duration;

/// The lock file that makes ownership of the socket name exclusive.
pub(crate) const LOCK_FILE: &str = "lock";

/// How long a claim waits out a lock held only in passing, and how often it
/// re-checks. A released claim is NOT free instantly: every process this app
/// spawns (a PTY agent, a git child) inherits open descriptors across fork
/// and keeps our lock alive until it execs, so a claim taken right after a
/// release can still see the old one — measured at ~3ms under load, which
/// is exactly the Off→On gap a user produces by flipping the toggle twice.
/// Waiting costs a genuine refusal a fraction of a second; not waiting costs
/// a legitimate re-enable a false "another instance owns this".
const CLAIM_TIMEOUT: Duration = Duration::from_millis(250);
const CLAIM_RETRY: Duration = Duration::from_millis(5);

/// Take the exclusive claim on the socket name. Contention and failure are
/// DIFFERENT answers: a name another instance holds is a refusal the user
/// can act on, while a failed lock call is a fault that must say what it
/// was — collapsing the two hid an interrupted call behind a wrong
/// diagnosis. `flock(2)` is interruptible, so a signal is retried too.
pub(super) fn claim(lock: &File, path: &Path) -> Result<(), String> {
    let deadline = std::time::Instant::now() + CLAIM_TIMEOUT;
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "{} is already served by another KeepDeck instance",
                        path.display()
                    ));
                }
                std::thread::sleep(CLAIM_RETRY);
            }
            Err(std::fs::TryLockError::Error(e))
                if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(std::fs::TryLockError::Error(e)) => {
                return Err(format!("claiming {} failed: {e}", path.display()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::server::test_support::temp_sock;

    #[test]
    fn a_claim_waits_out_a_holder_that_lets_go() {
        // Releasing a claim does not free it instantly: a process that
        // forked while we held it keeps it alive until it execs, and this
        // app forks constantly (PTY agents, git). A user flipping the toggle
        // Off then On lands in exactly that window.
        let path = temp_sock();
        let lock_path = path.parent().unwrap().join(LOCK_FILE);
        let holder = File::create(&lock_path).expect("lock file");
        holder.try_lock().expect("hold the claim");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            drop(holder);
        });

        let ours = File::create(&lock_path).expect("lock file");
        claim(&ours, &path).expect("a claim held in passing must not be refused");
    }

    #[test]
    fn a_claim_a_holder_keeps_is_refused_as_contention() {
        let path = temp_sock();
        let lock_path = path.parent().unwrap().join(LOCK_FILE);
        let holder = File::create(&lock_path).expect("lock file");
        holder.try_lock().expect("hold the claim");

        let ours = File::create(&lock_path).expect("lock file");
        let refused = claim(&ours, &path).expect_err("a held claim must be refused");
        assert!(refused.contains("another KeepDeck instance"), "{refused}");
    }
}
