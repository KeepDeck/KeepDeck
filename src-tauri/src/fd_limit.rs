//! How many files the app may hold open at once.
//!
//! An app started from Finder or the Dock inherits launchd's soft limit on
//! open files — 256 — and nothing in KeepDeck or its dependencies raised it
//! (task-575): with a few dozen panes the main process already held 161. Every
//! terminal, socket, watcher and log shares that budget, and running out
//! fails a spawn or a skills stage with EMFILE. So the soft limit is raised
//! once, first thing at startup, to `OPEN_MAX` (or the hard limit, if that is
//! lower); the agents and shells the app spawns inherit it.

use std::io;

/// The most the soft limit is raised to: macOS's `OPEN_MAX`
/// (`<sys/syslimits.h>`), the value setrlimit(2) tells callers to use for an
/// open files `rlim_cur` — "use rlim_cur = min(OPEN_MAX, rlim_max)". Not the
/// kernel's own ceiling (a terminal shell may already run far above it, and
/// that is left alone); forty times what the app held with dozens of panes
/// open.
const OPEN_MAX: libc::rlim_t = 10_240;

/// What raising the limit did, said in the log once the log is up.
#[derive(Debug)]
pub(crate) enum Raised {
    /// From the inherited soft limit to the new one.
    To { from: libc::rlim_t, to: libc::rlim_t },
    /// The soft limit was already at or past what it would be raised to.
    Already(libc::rlim_t),
    /// It could not be read or set: the app runs with what it inherited.
    Failed(io::Error),
}

impl Raised {
    pub(crate) fn log(&self) {
        match self {
            Raised::To { from, to } => log::info!("open files: soft limit raised from {from} to {to}"),
            Raised::Already(at) => log::info!("open files: soft limit already {at}"),
            Raised::Failed(e) => {
                log::warn!("open files: the soft limit could not be raised, running with the inherited one: {e}")
            }
        }
    }
}

/// Raise this process's soft limit on open files to `OPEN_MAX`, or the hard
/// limit if that is lower. Called once, before any thread or terminal exists.
pub(crate) fn raise() -> Raised {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: a valid pointer to an rlimit, alive for the call.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Raised::Failed(io::Error::last_os_error());
    }
    let from = limit.rlim_cur;
    let Some(to) = target(from, limit.rlim_max) else {
        return Raised::Already(from);
    };
    limit.rlim_cur = to;
    // SAFETY: a valid pointer to an initialised rlimit, alive for the call.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        return Raised::Failed(io::Error::last_os_error());
    }
    Raised::To { from, to }
}

/// The soft limit to set, or None when it is already there or past it. It
/// never lowers one: a limit somebody raised past the ceiling stays.
fn target(soft: libc::rlim_t, hard: libc::rlim_t) -> Option<libc::rlim_t> {
    let most = hard.min(OPEN_MAX);
    (soft < most).then_some(most)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_soft_limit_goes_up_to_the_hard_one_or_the_ceiling_whichever_is_lower() {
        // launchd's default: 256, under no hard limit at all.
        assert_eq!(target(256, libc::RLIM_INFINITY), Some(OPEN_MAX));
        assert_eq!(target(256, 4096), Some(4096));
        assert_eq!(target(256, 256), None);
    }

    #[test]
    fn a_soft_limit_already_at_or_past_the_ceiling_stays() {
        assert_eq!(target(OPEN_MAX, libc::RLIM_INFINITY), None);
        assert_eq!(target(61_440, libc::RLIM_INFINITY), None);
    }

    #[test]
    fn raising_leaves_the_process_at_or_past_the_ceiling_and_a_second_raise_finds_it_there() {
        let raised = raise();
        assert!(matches!(raised, Raised::To { .. } | Raised::Already(_)), "{raised:?}");
        let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: a valid pointer to an rlimit, alive for the call.
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) }, 0);
        assert!(limit.rlim_cur >= limit.rlim_max.min(OPEN_MAX), "{} under {}", limit.rlim_cur, limit.rlim_max);
        assert!(matches!(raise(), Raised::Already(_)));
    }
}
