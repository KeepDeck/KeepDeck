//! Whether an envelope comes from inside the pane it speaks for.
//!
//! Every pane's process tree inherits its `KEEPDECK_BRIDGE` — the address,
//! the pane, the secret — so the secret proves only that a sender started
//! somewhere under that pane, once. It does not prove the sender is still
//! there. An agent that starts a daemon from a pane hands it the pane's whole
//! environment, and the daemon's workers then report as that pane for the
//! rest of their lives: claude 2.1.303's background workers did exactly this,
//! rebinding the first pane that started the daemon to every conversation
//! sent to the background from ANY pane.
//!
//! What a detached process cannot keep is the terminal. The pane's PTY child
//! leads a session, and a process that left it with `setsid` — every daemon
//! does — is no longer in it. So a report that names its process is taken
//! only from a process running in the pane's terminal now.
//!
//! A report that names no process is let through unchanged: the deck's own
//! rules for an unnamed reporter apply to it, as before. Every shipped
//! reporter names itself.

/// Why an envelope was refused, in words for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refusal {
    /// The reporter field is not a process id.
    NotAProcess,
    /// The pane has no live terminal: nothing in it is alive to report.
    NoTerminal,
    /// The process runs, but not in the pane's terminal.
    Outside,
}

impl Refusal {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::NotAProcess => "its reporter names no process",
            Self::NoTerminal => "the pane has no live terminal",
            Self::Outside => "its reporter runs outside the pane's terminal",
        }
    }
}

/// Judge one envelope's sender. `runs_in_pane(pid)` answers whether that
/// process runs in the pane's terminal, or None when the pane has none.
pub(super) fn judge(
    reporter: Option<&str>,
    runs_in_pane: impl FnOnce(u32) -> Option<bool>,
) -> Result<(), Refusal> {
    let Some(reporter) = reporter else {
        return Ok(());
    };
    let pid: u32 = reporter.parse().map_err(|_| Refusal::NotAProcess)?;
    match runs_in_pane(pid) {
        Some(true) => Ok(()),
        Some(false) => Err(Refusal::Outside),
        None => Err(Refusal::NoTerminal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_in_the_panes_terminal_speaks_for_it() {
        let mut asked = None;
        let verdict = judge(Some("4021"), |pid| {
            asked = Some(pid);
            Some(true)
        });
        assert_eq!(verdict, Ok(()));
        assert_eq!(asked, Some(4021), "the reporter is the pid that is asked about");
    }

    #[test]
    fn a_detached_process_does_not_even_with_the_panes_secret() {
        assert_eq!(judge(Some("4021"), |_| Some(false)), Err(Refusal::Outside));
    }

    #[test]
    fn nothing_speaks_for_a_pane_with_no_live_terminal() {
        // After /bg the pane's own claude is gone and its worker reports on;
        // that worker must not move the pane's session to itself.
        assert_eq!(judge(Some("4021"), |_| None), Err(Refusal::NoTerminal));
    }

    #[test]
    fn a_reporter_that_is_not_a_pid_is_refused_without_asking() {
        for odd in ["", "-1", "12 34", "4021x", "99999999999"] {
            let verdict = judge(Some(odd), |_| panic!("asked about {odd:?}"));
            assert_eq!(verdict, Err(Refusal::NotAProcess), "{odd:?}");
        }
    }

    #[test]
    fn an_unnamed_reporter_is_left_to_the_decks_own_rules() {
        assert_eq!(judge(None, |_| panic!("nothing to ask about")), Ok(()));
    }
}
