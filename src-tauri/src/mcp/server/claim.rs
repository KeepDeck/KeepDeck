//! Owning the socket NAME, and the directory that guards it.
//!
//! Two questions this module answers before anything binds: may this process
//! serve at this path (an flock-backed claim, since `bind(2)` alone cannot
//! arbitrate — the stale-socket cleanup unlinks the name first, so two
//! instances interleaving there would each remove the other's socket), and is
//! the directory it would serve from actually ours and closed to everyone
//! else.

use std::fs::File;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
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

/// Ready the socket's directory and return it. The directory IS the
/// transport's permission model (see paths::mcp_socket), so it is created
/// 0700 — never created loose and tightened after, which would leave a
/// window where another user can open a directory handle that survives the
/// chmod. A pre-existing directory is validated and retightened; a symlink
/// or a plain file in its place is refused rather than followed, so the
/// mode this code enforces is always the mode of the directory it serves
/// from.
pub(super) fn prepare_socket_dir(path: &Path) -> Result<PathBuf, String> {
    let dir = path
        .parent()
        .ok_or_else(|| "the MCP socket path has no directory".to_string())?;
    if let Some(home) = dir.parent() {
        std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "{} is a symlink — refusing to serve the MCP socket through it",
                    dir.display()
                ));
            }
            if !meta.is_dir() {
                return Err(format!("{} is not a directory", dir.display()));
            }
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Err(e) => return Err(e.to_string()),
    }
    Ok(dir.to_path_buf())
}

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
    use crate::mcp::server::test_support::{temp_base, temp_sock};

    #[test]
    fn a_directory_this_call_creates_is_born_owner_only() {
        // Not "created loose, tightened after": a window there would let
        // another user open a dirfd that survives the chmod.
        let path = temp_base().join("mcp.sock");
        let dir = prepare_socket_dir(&path).expect("prepare");
        let mode = std::fs::metadata(&dir).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_loosened_leftover_directory_is_retightened() {
        let path = temp_sock();
        let parent = path.parent().expect("parent").to_path_buf();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755))
            .expect("loosen");
        prepare_socket_dir(&path).expect("prepare");
        let mode = std::fs::metadata(&parent).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_symlinked_socket_directory_is_refused() {
        // Following it would chmod — and serve from — whatever it points at.
        let base = temp_base();
        let real = base.join("real");
        std::fs::create_dir_all(&real).expect("real dir");
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        assert!(
            prepare_socket_dir(&link.join("mcp.sock")).is_err(),
            "a symlinked socket dir must be refused",
        );
    }

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
