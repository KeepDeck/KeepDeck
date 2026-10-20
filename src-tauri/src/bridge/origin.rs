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
//! What a daemon cannot keep is the terminal. The pane's PTY child leads a
//! session, the daemon left it with `setsid`, and its workers are its own
//! children. So a report that names its process is taken only from a
//! process belonging to the pane's terminal now — running in it, or started
//! directly by a process that does ([`keepdeck_pty::PtySession::hosts`]).
//! The MCP socket asks the same question of its clients.
//!
//! A report that names no process is let through unchanged: the deck's own
//! rules for an unnamed reporter apply to it, as before. Every shipped
//! reporter names itself.

/// Why an envelope was refused, in words for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refusal {
    /// The reporter field is not a process id.
    NotAProcess,
    /// The process does not belong to the pane's terminal — it belongs to
    /// another pane's, to none, or the pane has no live terminal at all.
    Outside,
}

impl Refusal {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::NotAProcess => "its reporter names no process",
            Self::Outside => "its reporter does not belong to the pane's terminal",
        }
    }
}

/// Judge one envelope's sender for `pane`. `pane_of(pid)` names the pane
/// whose terminal that process belongs to, if any.
pub(super) fn judge(
    reporter: Option<&str>,
    pane: &str,
    pane_of: impl FnOnce(u32) -> Option<String>,
) -> Result<(), Refusal> {
    let Some(reporter) = reporter else {
        return Ok(());
    };
    let pid: u32 = reporter.parse().map_err(|_| Refusal::NotAProcess)?;
    match pane_of(pid) {
        Some(owner) if owner == pane => Ok(()),
        _ => Err(Refusal::Outside),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_of_the_panes_terminal_speaks_for_it() {
        let mut asked = None;
        let verdict = judge(Some("4021"), "pane-5", |pid| {
            asked = Some(pid);
            Some("pane-5".into())
        });
        assert_eq!(verdict, Ok(()));
        assert_eq!(asked, Some(4021), "the reporter is the pid that is asked about");
    }

    #[test]
    fn a_daemons_worker_does_not_even_with_the_panes_secret() {
        assert_eq!(judge(Some("4021"), "pane-5", |_| None), Err(Refusal::Outside));
    }

    #[test]
    fn another_panes_process_does_not_speak_for_this_one() {
        assert_eq!(
            judge(Some("4021"), "pane-5", |_| Some("pane-6".into())),
            Err(Refusal::Outside),
        );
    }

    #[test]
    fn a_reporter_that_is_not_a_pid_is_refused_without_asking() {
        for odd in ["", "-1", "12 34", "4021x", "99999999999"] {
            let verdict = judge(Some(odd), "pane-5", |_| panic!("asked about {odd:?}"));
            assert_eq!(verdict, Err(Refusal::NotAProcess), "{odd:?}");
        }
    }

    #[test]
    fn an_unnamed_reporter_is_left_to_the_decks_own_rules() {
        assert_eq!(judge(None, "pane-5", |_| panic!("nothing to ask about")), Ok(()));
    }
}
