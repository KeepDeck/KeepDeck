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
//! children.
//!
//! At the door — the bridge's unix socket — the kernel names the sender, and
//! the sessions machine judges it ([`admitted`]): its process stands in, or
//! one session out from, a pane's live terminal, it names that session's
//! bridge secret, and the process it names, if any, belongs to that terminal
//! itself. So a daemon's worker naming itself is refused, and a process
//! outside every pane is refused whatever it names.

use keepdeck_lifecycle::domain::ids::PaneId;
use keepdeck_pty::sessions::{CallerRefusal, Named};

/// Why an envelope was refused, in words for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refusal {
    /// The sessions machine's word on a sender at the door.
    Caller(CallerRefusal),
    /// The sender speaks for one pane, and its terminal and secret are
    /// another's.
    OtherPane,
}

impl Refusal {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::Caller(CallerRefusal::NamedNotAProcess) => "its reporter names no process",
            Self::Caller(CallerRefusal::NoSecret) => "it names no secret",
            Self::Caller(CallerRefusal::OutsideTerminal) => "its process stands in no live pane's terminal",
            Self::Caller(CallerRefusal::WrongSecret) => "its secret is not its terminal's bridge secret",
            Self::Caller(CallerRefusal::NeverRegistered) => "its terminal was never registered",
            Self::Caller(CallerRefusal::NamedOutside) => "its reporter does not belong to its terminal",
            Self::OtherPane => "it speaks for another pane than its terminal's",
        }
    }
}

/// The process an envelope names as its sender — `payload.reporter`, read
/// as a process id.
pub(super) fn named(reporter: Option<&str>) -> Named<u32> {
    match reporter {
        None => Named::None,
        Some(reporter) => reporter.parse().map_or(Named::NotAProcess, Named::Process),
    }
}

/// Judge one envelope at the door, for `pane`, by the sessions machine's word
/// on its sender: admitted for that very pane, or refused.
pub(super) fn admitted(admitted: Result<PaneId, CallerRefusal>, pane: &str) -> Result<(), Refusal> {
    match admitted {
        Ok(admitted) if admitted.to_string() == pane => Ok(()),
        Ok(_) => Err(Refusal::OtherPane),
        Err(refusal) => Err(Refusal::Caller(refusal)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_door_reads_the_named_process_as_a_process_id_or_as_none() {
        assert_eq!(named(None), Named::None);
        assert_eq!(named(Some("4021")), Named::Process(4021));
        for odd in ["", "-1", "12 34", "4021x", "99999999999"] {
            assert_eq!(named(Some(odd)), Named::NotAProcess, "{odd:?}");
        }
    }

    #[test]
    fn the_door_takes_an_envelope_only_for_the_pane_its_sender_was_admitted_for() {
        assert_eq!(admitted(Ok(PaneId(5)), &PaneId(5).to_string()), Ok(()));
        // Its terminal and secret are pane 6's: it may not speak for pane 5.
        assert_eq!(admitted(Ok(PaneId(6)), &PaneId(5).to_string()), Err(Refusal::OtherPane));
        assert_eq!(
            admitted(Err(CallerRefusal::NamedOutside), "pane-5"),
            Err(Refusal::Caller(CallerRefusal::NamedOutside)),
        );
    }
}
