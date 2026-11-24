//! One copy per settings folder. The first thing the app does is ask whether
//! this process may own its home: the flock on the lifecycle journal's root,
//! the claim the lifecycle machine runs on for the app's whole life. A home
//! another copy holds is let alone — this copy says so and exits, before it
//! has written a byte into it; a home that cannot be owned stops it with the
//! reason. A second copy that went on would write the stores the first one
//! writes, and once the first one quit it would take over with the deck it
//! loaded at its own start.
//!
//! How long to wait for a holder and what each way out is are the lifecycle
//! domain's rules (`keepdeck_lifecycle::domain::single`); here are the IO
//! and the words.

use crate::fs_claim::{self, ClaimedRoot, Refusal, Step};
use keepdeck_lifecycle::domain::single::{self as rules, Holder, Say, Way};
use keepdeck_lifecycle::infrastructure::machine::{self, Loaded};
use std::fmt;
use std::path::{Path, PathBuf};

/// The lifecycle journal's root in a home: the folder whose claim is the
/// copy's. Spelled here only.
const JOURNAL_FOLDER: &str = "lifecycle";

/// A home this copy owns, for as long as the claim is held — and its
/// lifecycle journal, read once, under the claim: the read removes what it
/// cannot replay, so it is carried to the machine rather than read again.
pub struct Owned {
    pub claim: ClaimedRoot,
    pub journal: Loaded,
}

/// What a process may do with a home.
pub enum Copy {
    /// The home is this copy's.
    This(Owned),
    /// Another copy holds it: what its lock said when the wait ran out, and
    /// the way out that makes.
    Refused { holder: Option<Holder>, way: Way },
    /// It cannot be owned.
    Fault(Fault),
}

/// Why a home cannot be owned.
#[derive(Debug)]
pub enum Fault {
    /// No home to look in: no `HOME` to put the settings folder under.
    NoHome,
    /// The journal's root could not be made, its lock opened or locked.
    Claim { root: PathBuf, step: Step, error: std::io::Error },
    /// The journal could not be read: an unread journal is not an empty one,
    /// and no copy may start as if the operations it holds were done.
    Journal { root: PathBuf, error: std::io::Error },
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Fault::NoHome => write!(f, "there is no home folder to keep it in"),
            Fault::Claim { root, step: Step::MakeRoot, error } => write!(f, "creating {} failed: {error}", root.display()),
            Fault::Claim { root, step: Step::OpenLock, error } => {
                write!(f, "opening {} failed: {error}", root.join(fs_claim::LOCK_FILE).display())
            }
            Fault::Claim { root, step: Step::Lock, error } => {
                write!(f, "locking {} failed: {error}", root.join(fs_claim::LOCK_FILE).display())
            }
            Fault::Journal { root, error } => write!(f, "reading the journal in {} failed: {error}", root.display()),
        }
    }
}

/// May this process own `home`. The patience comes from what the lock says
/// of its holder; the way out, from what it says when the wait has run out.
pub fn enter(home: &Path) -> Copy {
    let root = home.join(JOURNAL_FOLDER);
    let patience = rules::patience(fs_claim::holder(&root));
    match fs_claim::claim_within(&root, patience.duration()) {
        Ok(claim) => match machine::load_journal(&root, fs_claim::LOCK_FILE) {
            Ok(journal) => Copy::This(Owned { claim, journal }),
            Err(error) => Copy::Fault(Fault::Journal { root, error }),
        },
        Err(Refusal::Held { holder }) => Copy::Refused { holder, way: rules::way(patience, holder) },
        Err(Refusal::Fault { step, error }) => Copy::Fault(Fault::Claim { root, step, error }),
    }
}

/// The home's claim and its journal — or this process ends, having said
/// why. What the windowed app asks before anything else.
pub fn own_home() -> Owned {
    let copy = match crate::paths::keepdeck_home() {
        Some(home) => enter(&home),
        None => Copy::Fault(Fault::NoHome),
    };
    match copy {
        Copy::This(owned) => owned,
        Copy::Refused { holder, way } => {
            if let Some(holder) = holder {
                eprintln!("KeepDeck: the settings folder is held by pid {}", holder.pid);
            }
            let say = rules::say(way);
            leave(words(say), rules::exit_code(say))
        }
        Copy::Fault(fault) => leave(format!("{} {fault}.", words(Say::Unusable)), rules::exit_code(Say::Unusable)),
    }
}

/// The words for what a copy that does not start says.
fn words(say: Say) -> String {
    match say {
        Say::AlreadyRunning => "KeepDeck is already running. Choose it with ⌘Tab, or click it in the Dock. \
                                If it does not answer, force-quit it and open KeepDeck again."
            .to_owned(),
        Say::StillLeaving => {
            "KeepDeck could not restart: the copy it is replacing is still quitting. Force-quit KeepDeck and open it again.".to_owned()
        }
        Say::Unusable => "KeepDeck could not open its settings folder:".to_owned(),
    }
}

/// Say it — on stderr, and in a dialog, since a copy started from the Dock
/// has no terminal — and end the process. Nothing of Tauri exists yet: the
/// dialog runs its own modal loop.
fn leave(words: String, code: i32) -> ! {
    eprintln!("KeepDeck: {words}");
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title("KeepDeck")
        .set_description(&words)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    std::process::exit(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use keepdeck_lifecycle::domain::single::{RELAUNCH_PATIENCE, ORDINARY_PATIENCE};
    use std::time::{Duration, Instant};

    /// How long a holder in these tests keeps the home before it lets go:
    /// well past the ordinary patience, well inside the relaunch one.
    const HELD_FOR: Duration = Duration::from_secs(1);

    fn us(leaving: bool) -> Option<Holder> {
        Some(Holder { pid: std::process::id(), leaving })
    }

    fn root(home: &Path) -> PathBuf {
        home.join(JOURNAL_FOLDER)
    }

    /// A holder of `home` that lets go after `HELD_FOR`, `prepare` run on it first.
    fn letting_go(home: &Path, prepare: impl FnOnce(&ClaimedRoot) + Send + 'static) -> std::thread::JoinHandle<()> {
        let held = fs_claim::claim_within(&root(home), ORDINARY_PATIENCE).expect("the first copy");
        prepare(&held);
        std::thread::spawn(move || {
            std::thread::sleep(HELD_FOR);
            drop(held);
        })
    }

    #[test]
    fn the_restart_code_the_rules_know_is_tauris() {
        assert_eq!(rules::RESTART_EXIT_CODE, tauri::RESTART_EXIT_CODE);
    }

    #[test]
    fn a_free_home_is_this_copys_and_its_lock_names_it() {
        let home = tempfile::tempdir().unwrap();
        let Copy::This(owned) = enter(home.path()) else { panic!("a free home") };
        assert_eq!(owned.claim.root(), root(home.path()));
        assert_eq!(fs_claim::holder(&root(home.path())), us(false));
    }

    #[test]
    fn a_home_a_running_copy_holds_is_refused_at_once() {
        let home = tempfile::tempdir().unwrap();
        let Copy::This(_first) = enter(home.path()) else { panic!("the first copy") };
        let started = Instant::now();
        let refused = enter(home.path());
        let waited = started.elapsed();
        assert!(matches!(refused, Copy::Refused { holder, way: Way::Occupied } if holder == us(false)), "refused as occupied");
        assert!(waited < RELAUNCH_PATIENCE / 5, "an ordinary second launch waited {waited:?}");
    }

    #[test]
    fn a_copy_that_is_leaving_is_waited_for() {
        let home = tempfile::tempdir().unwrap();
        let first = letting_go(home.path(), |held| held.set_leaving());
        let started = Instant::now();
        let copy = enter(home.path());
        assert!(matches!(copy, Copy::This(_)), "the replacement comes up");
        assert!(started.elapsed() >= HELD_FOR - Duration::from_millis(50), "it waited for the leaving copy");
        first.join().unwrap();
    }

    #[test]
    fn a_holder_that_names_nothing_is_waited_for_too() {
        let home = tempfile::tempdir().unwrap();
        // What an older build leaves in its lock: nothing.
        let lock = root(home.path()).join(fs_claim::LOCK_FILE);
        let first = letting_go(home.path(), move |_| std::fs::write(lock, "").unwrap());
        let copy = enter(home.path());
        assert!(matches!(copy, Copy::This(_)), "the copy after an older build comes up");
        first.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_home_whose_journal_cannot_be_read_is_a_fault() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        // Its lock can be made and taken; its entries cannot be listed.
        std::fs::create_dir_all(root(home.path())).unwrap();
        std::fs::set_permissions(root(home.path()), std::fs::Permissions::from_mode(0o300)).unwrap();
        let copy = enter(home.path());
        std::fs::set_permissions(root(home.path()), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(copy, Copy::Fault(Fault::Journal { .. })), "a fault");
    }

    #[test]
    fn a_home_that_cannot_be_owned_is_a_fault_not_a_holder() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::write(&home, "a file where the home must be").unwrap();
        let copy = enter(&home);
        assert!(matches!(copy, Copy::Fault(Fault::Claim { step: Step::MakeRoot, .. })), "a fault");
    }
}
