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

/// The home's claim and its journal — or this process ends, having brought
/// the copy in its way to the front or said why it could not. What the
/// windowed app asks before anything else. `ours` is the app's bundle
/// identifier, as its configuration names it: a build run as a bare binary
/// has none of its own to compare with.
pub fn own_home(ours: &str) -> Owned {
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
            let handed_over = rules::reopens(way) && reopen(ours, holder);
            leave(rules::say(way, handed_over), None)
        }
        Copy::Fault(fault) => leave(Say::Unusable, Some(&fault)),
    }
}

/// The words for what a copy that does not start says — none when it has
/// nothing to say.
fn words(say: Say, fault: Option<&Fault>) -> Option<String> {
    match say {
        Say::Nothing => None,
        Say::AlreadyRunning => Some(
            "KeepDeck is already running. This copy could not bring it forward — choose KeepDeck with ⌘Tab, \
             or click it in the Dock. If it does not answer, force-quit it and open KeepDeck again."
                .to_owned(),
        ),
        Say::StillLeaving => Some(
            "KeepDeck could not restart: the copy it is replacing is still quitting. Force-quit KeepDeck and open it again."
                .to_owned(),
        ),
        Say::Unusable => Some(match fault {
            Some(fault) => format!("KeepDeck could not open its settings folder: {fault}."),
            None => "KeepDeck could not open its settings folder.".to_owned(),
        }),
    }
}

/// Say it, if there is anything to say — on stderr, and in a dialog, since a
/// copy started from the Dock has no terminal — and end the process.
/// Nothing of Tauri exists yet: the dialog runs its own modal loop.
fn leave(say: Say, fault: Option<&Fault>) -> ! {
    if let Some(words) = words(say, fault) {
        eprintln!("KeepDeck: {words}");
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title("KeepDeck")
            .set_description(&words)
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
    }
    std::process::exit(rules::exit_code(say))
}

/// How long the second copy waits for LaunchServices to say it reopened
/// the first.
#[cfg(target_os = "macos")]
const FOCUS_BOUND: std::time::Duration = std::time::Duration::from_secs(3);

/// Bring the copy in the way to the front: ask LaunchServices to reopen its
/// bundle, as a click on its Dock icon does. That reopen unhides it,
/// restores a minimized window and moves to its full-screen Space, from a
/// terminal launch too — an activation request does none of that reliably
/// (measured on macOS 15.7.4). Found by the pid its lock names, or — when it
/// names none, an older build — as the one other running application of
/// ours. Only KeepDeck is reopened: a pid can have gone to another app
/// since. The call answers asynchronously, and this process runs no event
/// loop: the answer is waited for, bounded. A holder that exits in that
/// window is launched again by the reopen, and passes the door as any
/// launch does.
#[cfg(target_os = "macos")]
fn reopen(ours: &str, holder: Option<Holder>) -> bool {
    use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
    use objc2_foundation::{NSError, NSString};
    let me = std::process::id() as libc::pid_t;
    let ours = NSString::from_str(ours);
    let target = match holder {
        Some(holder) => NSRunningApplication::runningApplicationWithProcessIdentifier(holder.pid as libc::pid_t),
        None => {
            let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&ours);
            let mut others = running.iter().filter(|app| app.processIdentifier() != me);
            match (others.next(), others.next()) {
                (Some(one), None) => Some(one),
                _ => None,
            }
        }
    };
    let Some(target) = target else { return false };
    if !target.bundleIdentifier().is_some_and(|identifier| identifier.isEqualToString(&ours)) {
        return false;
    }
    let Some(url) = target.bundleURL() else { return false };
    let holder_pid = target.processIdentifier() as u32;
    let configuration = NSWorkspaceOpenConfiguration::new();
    configuration.setActivates(true);
    let (done, answered) = std::sync::mpsc::channel::<Result<u32, ()>>();
    let completion = block2::RcBlock::new(move |app: *mut NSRunningApplication, error: *mut NSError| {
        // SAFETY: LaunchServices hands the application it opened, or nil,
        // valid for the call.
        let opened = if error.is_null() { unsafe { app.as_ref() }.map(|app| app.processIdentifier() as u32) } else { None };
        let _ = done.send(opened.ok_or(()));
    });
    NSWorkspace::sharedWorkspace().openApplicationAtURL_configuration_completionHandler(&url, &configuration, Some(&completion));
    rules::handed_over(answered.recv_timeout(FOCUS_BOUND).ok(), holder_pid)
}

/// Nothing to bring forward where LaunchServices is not.
#[cfg(not(target_os = "macos"))]
fn reopen(_ours: &str, _holder: Option<Holder>) -> bool {
    false
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

    /// The app's identifier, as tauri.conf.json names it.
    #[cfg(target_os = "macos")]
    const OURS: &str = "ai.keepdeck.desktop";

    #[cfg(target_os = "macos")]
    #[test]
    fn a_pid_that_is_no_application_is_not_reopened() {
        assert!(!reopen(OURS, Some(Holder { pid: 999_999, leaving: false })));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_application_that_is_not_ours_is_not_reopened() {
        // A pid the lock names may since have gone to another application:
        // Finder stands for it. Without the guard, Finder would be reopened.
        let finder = objc2_app_kit::NSRunningApplication::runningApplicationsWithBundleIdentifier(
            &objc2_foundation::NSString::from_str("com.apple.finder"),
        );
        let Some(finder) = finder.iter().next() else {
            eprintln!("no Finder runs here: no other application to try");
            return;
        };
        let pid = finder.processIdentifier() as u32;
        assert!(!reopen(OURS, Some(Holder { pid, leaving: false })));
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
