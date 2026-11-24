//! One copy per settings folder: what a home's lock says about the process
//! that holds it, how long a second copy waits for it, and what that copy
//! does when it may not start. Pure; the lock, the processes and the words
//! are the app's.

use std::time::Duration;

/// What the lock of a held home says about its holder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Holder {
    pub pid: u32,
    /// The holder was asked to restart and is on its way out.
    pub leaving: bool,
}

/// The pid's width on the line: ten digits hold every `u32`. Every line is
/// then as long as every other, so a line written over another leaves
/// nothing of it behind — whatever the two pids — and a reader never meets
/// a shorter line than the one it replaced.
const PID_WIDTH: usize = 10;

/// The two words are as long as each other for the same reason.
const RUNNING: &str = "running";
const LEAVING: &str = "leaving";

/// The lock's one line: `<pid> running` or `<pid> leaving`, the pid padded
/// with zeros to its width.
pub fn lock_line(holder: Holder) -> String {
    let word = if holder.leaving { LEAVING } else { RUNNING };
    format!("{:0width$} {word}", holder.pid, width = PID_WIDTH)
}

/// The holder a lock line names, or `None` for anything else: empty, torn,
/// garbage — or the lock of a build that writes nothing into it.
pub fn parse_lock_line(line: &str) -> Option<Holder> {
    let (pid, word) = line.split_once(' ')?;
    if pid.len() != PID_WIDTH || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let leaving = match word {
        RUNNING => false,
        LEAVING => true,
        _ => return None,
    };
    Some(Holder { pid: pid.parse().ok()?, leaving })
}

/// How long a second copy waits for a held home to be let go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Patience {
    /// A copy going about its business is not waited for: only the moment a
    /// process takes to let go of a lock its children still hold open.
    Ordinary,
    /// A copy that asked for a replacement is waited for until it is gone.
    Relaunch,
}

/// The patience of every claim on a store's root, the stores' as well.
pub const ORDINARY_PATIENCE: Duration = Duration::from_millis(250);

/// A restart stops the old copy's sessions before it starts the new one;
/// what is left to wait for is the old process's own exit. Margin for a slow
/// teardown on a loaded machine.
pub const RELAUNCH_PATIENCE: Duration = Duration::from_secs(10);

impl Patience {
    pub fn duration(self) -> Duration {
        match self {
            Patience::Ordinary => ORDINARY_PATIENCE,
            Patience::Relaunch => RELAUNCH_PATIENCE,
        }
    }
}

/// A copy that is leaving is waited for: it asked for a replacement. So is a
/// holder that names nothing — a build that does not write its lock, which is
/// the copy this build first replaces. A running copy that names itself is not.
pub fn patience(holder: Option<Holder>) -> Patience {
    match holder {
        Some(Holder { leaving: false, .. }) => Patience::Ordinary,
        Some(Holder { leaving: true, .. }) | None => Patience::Relaunch,
    }
}

/// The exit code Tauri asks a restart with (`tauri::RESTART_EXIT_CODE`).
pub const RESTART_EXIT_CODE: i32 = i32::MAX;

/// What an exit the app was asked for is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitKind {
    Quit,
    Restart,
}

pub fn exit_kind(code: Option<i32>) -> ExitKind {
    if code == Some(RESTART_EXIT_CODE) {
        ExitKind::Restart
    } else {
        ExitKind::Quit
    }
}

/// Why a copy did not start on a home another holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Way {
    /// A copy going about its business: yield to it.
    Occupied,
    /// It said it was leaving and is still there: the replacement it asked
    /// for cannot come up.
    StillLeaving,
}

/// The way out of a held home, by the patience the wait was given and what
/// the lock said when it ran out. Only a holder still leaving after the
/// whole relaunch wait is one that did not leave: one found leaving at the
/// end of an ordinary wait began to leave meanwhile and was not waited for.
pub fn way(patience: Patience, holder: Option<Holder>) -> Way {
    match (patience, holder) {
        (Patience::Relaunch, Some(Holder { leaving: true, .. })) => Way::StillLeaving,
        _ => Way::Occupied,
    }
}

/// What a copy that does not start tells the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Say {
    /// Another copy runs on this settings folder.
    AlreadyRunning,
    /// The copy this one was to replace is still quitting.
    StillLeaving,
    /// The settings folder cannot be owned at all.
    Unusable,
}

pub fn say(way: Way) -> Say {
    match way {
        Way::Occupied => Say::AlreadyRunning,
        Way::StillLeaving => Say::StillLeaving,
    }
}

/// The process's exit code for what it said: 3 when another copy simply
/// runs, 4 when something is wrong.
pub fn exit_code(say: Say) -> i32 {
    match say {
        Say::AlreadyRunning => 3,
        Say::StillLeaving | Say::Unusable => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNNING_COPY: Option<Holder> = Some(Holder { pid: 41, leaving: false });
    const LEAVING_COPY: Option<Holder> = Some(Holder { pid: 41, leaving: true });

    #[test]
    fn a_running_copy_gets_the_ordinary_patience_a_leaving_one_and_a_nameless_one_the_relaunch() {
        assert_eq!(patience(RUNNING_COPY), Patience::Ordinary);
        assert_eq!(patience(LEAVING_COPY), Patience::Relaunch);
        assert_eq!(patience(None), Patience::Relaunch);
        assert_eq!(Patience::Ordinary.duration(), ORDINARY_PATIENCE);
        assert_eq!(Patience::Relaunch.duration(), RELAUNCH_PATIENCE);
    }

    #[test]
    fn only_the_restart_code_is_a_restart() {
        assert_eq!(exit_kind(None), ExitKind::Quit);
        assert_eq!(exit_kind(Some(0)), ExitKind::Quit);
        assert_eq!(exit_kind(Some(1)), ExitKind::Quit);
        assert_eq!(exit_kind(Some(i32::MAX)), ExitKind::Restart);
    }

    #[test]
    fn the_way_out_is_named_by_what_the_lock_said_when_the_wait_ran_out() {
        assert_eq!(way(Patience::Relaunch, LEAVING_COPY), Way::StillLeaving);
        assert_eq!(way(Patience::Relaunch, None), Way::Occupied, "a nameless holder may simply be running");
        assert_eq!(way(Patience::Relaunch, RUNNING_COPY), Way::Occupied, "a third copy won the home meanwhile");
        assert_eq!(way(Patience::Ordinary, RUNNING_COPY), Way::Occupied);
        assert_eq!(way(Patience::Ordinary, LEAVING_COPY), Way::Occupied, "it began to leave while this copy waited the ordinary wait");
        assert_eq!(way(Patience::Ordinary, None), Way::Occupied);
    }

    #[test]
    fn a_copy_that_does_not_start_says_why_and_exits_by_it() {
        assert_eq!(say(Way::Occupied), Say::AlreadyRunning);
        assert_eq!(say(Way::StillLeaving), Say::StillLeaving);
        assert_eq!(exit_code(Say::AlreadyRunning), 3);
        assert_eq!(exit_code(Say::StillLeaving), 4);
        assert_eq!(exit_code(Say::Unusable), 4);
    }

    #[test]
    fn a_lock_line_names_its_holder_and_whether_it_is_leaving() {
        for pid in [0, 7, 54_321, u32::MAX] {
            for leaving in [false, true] {
                let holder = Holder { pid, leaving };
                assert_eq!(parse_lock_line(&lock_line(holder)), Some(holder), "{holder:?}");
            }
        }
    }

    #[test]
    fn every_lock_line_is_as_long_as_every_other() {
        let length = lock_line(Holder { pid: 0, leaving: false }).len();
        for pid in [7, 999, 54_321, u32::MAX] {
            for leaving in [false, true] {
                assert_eq!(lock_line(Holder { pid, leaving }).len(), length, "pid {pid}, leaving {leaving}");
            }
        }
    }

    #[test]
    fn a_lock_line_that_is_empty_torn_or_garbage_names_no_one() {
        let whole = lock_line(Holder { pid: 12_345, leaving: false });
        for line in [
            "",
            &whole[..whole.len() - 3],
            "0000012345",
            "running",
            "12345 running",
            "pid0000001 running",
            "0000012345 Running",
            "0000012345 running\n",
            "\n0000012345 running",
            "0000012345 running trailing",
            "0000012345  running",
        ] {
            assert_eq!(parse_lock_line(line), None, "{line:?}");
        }
    }
}
