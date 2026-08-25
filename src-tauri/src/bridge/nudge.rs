//! The deck's doorbell: telling a pane that mail is waiting, without typing
//! anything into it.
//!
//! Every CLI here reaches a turn boundary and ASKS what is waiting — that is
//! the labelled channel, and it costs nothing. The gap it leaves is the idle
//! pane: an agent that is not running has no boundary coming, so nothing ever
//! asks. For the hook CLIs the deck closes that gap by typing a line into the
//! terminal, which starts a turn, which fires the hook. It works, and it is
//! the one place where KeepDeck puts words in front of a model that the user
//! did not write.
//!
//! An agent whose reporter lives INSIDE its process needs no such thing. It
//! is already running, already holds the run directory from `KEEPDECK_BRIDGE`,
//! and can watch it. So the deck drops a file with the pane's name on it and
//! the reporter — which is the only thing here that knows how to talk to that
//! CLI — does the rest.
//!
//! The file carries NOTHING. Not the message, not the sender, not a count:
//! this is a doorbell, and every fact about the mail is already an answer the
//! reporter will get by asking through [`super::reply`]. Keeping it empty is
//! what stops a second, unlabelled delivery path growing here — one where
//! messages would arrive without ever passing the rules that decide whether
//! they may be delivered at all.

use super::spool;
use std::path::Path;

/// The file a ringing doorbell is. One per pane, because it lands in the
/// pane's own directory — a second ring before the first was answered
/// replaces it rather than piling up, and one pane cannot be more woken than
/// woken (one ask returns everything waiting anyway).
///
/// The name is fixed and carries no `.json`, which is what it kept from the
/// days when envelopes arrived as files here: a signal going OUT was never to
/// be read as one coming in.
const WAKE_FILE: &str = "mail.wake";

/// Ring one pane's doorbell.
///
/// Nobody takes the file down but the reporter that consumes it. A ring left
/// behind by a pane that died is inert: run directories are minted per launch
/// and swept, and a reporter finding one at startup asks once and is told
/// there is nothing waiting.
///
/// `Err` is a message for the log: a signal that never lands leaves the mail
/// sitting in its queue, where it either gets picked up at the agent's next
/// turn or expires and is reported back to its sender. Both are recoverable;
/// raising here would not make either happen sooner.
pub fn ring(run_dir: &Path, pane_id: &str) -> Result<(), String> {
    let dir = spool::pane_dir(run_dir, pane_id)?;
    spool::publish(&dir, WAKE_FILE, "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_ring_lands_whole_and_out_of_the_watcher_s_way() {
        let dir = tempfile::tempdir().unwrap();
        ring(dir.path(), "pane-1").unwrap();
        let path = dir.path().join("pane-1").join(WAKE_FILE);
        assert!(path.exists());
        // The inbox watcher only consumes `*.json` — a doorbell must not read
        // as an envelope arriving, or it would be parsed and logged as junk.
        assert_ne!(path.extension().unwrap(), "json");
        // Empty on purpose: everything about the mail is an answer the
        // reporter gets by asking, and content here would be a second
        // delivery path that skipped the delivery rules.
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        assert!(!dir.path().join("pane-1").join("mail.wake.tmp").exists());
    }

    #[test]
    fn ringing_twice_leaves_one_signal_for_one_pane() {
        // A pane that is woken again before it answered is not woken twice —
        // the reporter asks once and gets everything waiting in one answer.
        let dir = tempfile::tempdir().unwrap();
        ring(dir.path(), "pane-1").unwrap();
        ring(dir.path(), "pane-1").unwrap();
        assert_eq!(fs::read_dir(dir.path().join("pane-1")).unwrap().count(), 1);
        // And a ring for somebody else lands in that pane's own directory —
        // never a shared file another pane's reporter could answer.
        ring(dir.path(), "pane-2").unwrap();
        assert!(dir.path().join("pane-2").join(WAKE_FILE).exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn pane_ids_that_could_escape_the_run_directory_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let run = root.path().join("run-1");
        fs::create_dir(&run).unwrap();
        for hostile in ["../escaped", "..", "a/b", "", "nul\0byte"] {
            assert!(ring(&run, hostile).is_err(), "must refuse {hostile:?}");
        }
        assert!(!root.path().join("escaped.wake").exists());
        assert_eq!(fs::read_dir(&run).unwrap().count(), 0);
    }
}
