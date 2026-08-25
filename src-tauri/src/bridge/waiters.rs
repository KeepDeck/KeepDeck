//! Holding a connection open while the deck decides what to say.
//!
//! A hook that asks a question cannot be answered by the thread that took the
//! question: the answer comes from the webview, which learns of the question
//! only through the event the route emits. So the route parks on a channel
//! keyed by who asked and what they asked on, and whoever carries the deck's
//! answer back unparks it.
//!
//! This replaced a file and a poll. What went with them is the window in
//! which an answer existed on disk but nobody had come for it yet — and the
//! whole apparatus that window needed: a timer, a collected-check, a report
//! that nobody came, and a memory upstairs of what each answer carried so it
//! could be put back. A send here either reaches the hook or says it did not,
//! at the moment it happens.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

/// How long the deck holds a connection open before giving up on the webview.
///
/// The asker's own timeout is deliberately LONGER (`SEND_MAX` in the shell
/// reporters, the request timeout in the opencode plugin), so the deck's side
/// runs out first and the asker gets a 504 it can read rather than a socket
/// error it has to guess at. `scripts/reporterScripts.test.mjs` pins that
/// ordering across all three languages.
pub(super) const HOOK_WAIT: Duration = Duration::from_millis(2_500);

/// Who is waiting for what: the pane that asked, and the correlation it asked
/// on.
///
/// The pane is half the key, not decoration. An answer is ADDRESSED, and the
/// file lane addressed it by writing into the asking pane's own directory —
/// so a correlation guessed or reused by another pane could not reach it.
/// Keying on the correlation alone would have quietly dropped that.
type Who = (String, String);

/// Everyone currently parked.
#[derive(Default)]
pub(super) struct Waiters {
    parked: Mutex<HashMap<Who, SyncSender<String>>>,
}

impl Waiters {
    /// Take the slot for `pane`/`id`, or `None` if somebody already holds it.
    ///
    /// Separate from waiting on purpose, and the separation is the guarantee.
    /// The deck must not be TOLD about an ask it cannot be allowed to answer:
    /// a second ask reusing a live correlation would be answered "nothing
    /// waiting" — the first ask having just emptied the queue — and that
    /// answer would be handed to the first asker, which is still parked on
    /// that exact pair. Holding the slot first means a duplicate is refused
    /// before the deck ever hears of it.
    ///
    /// Neither shipped reporter reuses a correlation, so reaching this at all
    /// means something upstream is wrong.
    pub(super) fn park(&self, pane: &str, id: &str) -> Option<Parked<'_>> {
        let who = (pane.to_string(), id.to_string());
        // Bounded at one: the answer is sent once, and a sender that finds
        // nobody home must not block on a full queue.
        let (tx, rx) = sync_channel(1);
        match self.parked.lock().expect("waiters poisoned").entry(who.clone()) {
            Entry::Occupied(_) => return None,
            Entry::Vacant(slot) => slot.insert(tx),
        };
        Some(Parked {
            waiters: self,
            who,
            rx: Some(rx),
        })
    }

    /// Hand `body` to whoever is parked. `false` means nobody was — the
    /// caller still owns those messages, and they are only still the deck's
    /// because nothing carried them away.
    pub(super) fn resolve(&self, pane: &str, id: &str, body: String) -> bool {
        let parked = self
            .parked
            .lock()
            .expect("waiters poisoned")
            .remove(&(pane.to_string(), id.to_string()));
        match parked {
            // A full or disconnected channel means the waiter gave up between
            // the lookup and the send: not delivered, and the caller has to
            // hear that rather than assume.
            Some(tx) => tx.try_send(body).is_ok(),
            None => false,
        }
    }
}

/// One held slot. Dropping it frees the slot, so a waiter that gave up — or
/// a thread that panicked between parking and waiting — never leaves an entry
/// behind to swallow the next question on the same correlation.
pub(super) struct Parked<'a> {
    waiters: &'a Waiters,
    who: Who,
    /// Taken by [`Parked::wait`]; `Drop` still runs afterwards.
    rx: Option<Receiver<String>>,
}

impl Parked<'_> {
    /// Wait for the deck's answer, or give up after `patience`.
    ///
    /// `None` means nobody answered in time. That must not be read as an
    /// empty answer, which means "nothing was waiting for you" and loses
    /// nothing — silence may mean the deck already handed messages over.
    pub(super) fn wait(mut self, patience: Duration) -> Option<String> {
        let rx = self.rx.take().expect("a slot is waited on once");
        rx.recv_timeout(patience).ok()
    }
}

impl Drop for Parked<'_> {
    fn drop(&mut self) {
        self.waiters
            .parked
            .lock()
            .expect("waiters poisoned")
            .remove(&self.who);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn an_answer_reaches_the_thread_that_asked() {
        let waiters = Arc::new(Waiters::default());
        let answering = Arc::clone(&waiters);
        let parked = waiters.park("pane-1", "corr-1").expect("the slot is free");
        std::thread::spawn(move || {
            for _ in 0..100 {
                if answering.resolve("pane-1", "corr-1", "the answer".into()) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        assert_eq!(
            parked.wait(Duration::from_secs(2)),
            Some("the answer".to_string())
        );
    }

    #[test]
    fn nobody_answering_is_none_rather_than_an_empty_answer() {
        // An empty answer means "nothing was waiting for you" and loses
        // nothing; a timeout means the deck already handed messages over.
        let waiters = Waiters::default();
        let parked = waiters.park("pane-1", "corr-2").unwrap();
        assert_eq!(parked.wait(Duration::from_millis(50)), None);
    }

    #[test]
    fn resolving_an_unknown_correlation_reports_that_it_landed_nowhere() {
        let waiters = Waiters::default();
        assert!(!waiters.resolve("pane-1", "nobody-is-here", "answer".into()));
    }

    #[test]
    fn a_timed_out_waiter_leaves_nothing_behind_for_the_next_question() {
        let waiters = Waiters::default();
        assert_eq!(
            waiters.park("pane-1", "corr-3").unwrap().wait(Duration::from_millis(20)),
            None
        );
        // The stale entry would have swallowed this one.
        assert!(!waiters.resolve("pane-1", "corr-3", "late".into()));
        // And the slot is free again, rather than held by the thread that left.
        assert!(waiters.park("pane-1", "corr-3").is_some());
    }

    #[test]
    fn one_panes_answer_cannot_be_taken_by_another_pane() {
        // The property the file lane had by writing into the asking pane's
        // own directory. Keyed on the correlation alone, this would deliver.
        let waiters = Arc::new(Waiters::default());
        let answering = Arc::clone(&waiters);
        let parked = waiters.park("pane-1", "shared-corr").unwrap();
        let thief = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            answering.resolve("pane-2", "shared-corr", "not yours".into())
        });
        assert_eq!(parked.wait(Duration::from_millis(120)), None);
        assert!(!thief.join().unwrap());
    }

    #[test]
    fn a_second_ask_on_a_live_correlation_cannot_take_the_slot() {
        // Refused rather than swapped in — and refused BEFORE the deck is
        // told, which is what stops the second ask's answer being handed to
        // the first one.
        let waiters = Waiters::default();
        let first = waiters.park("pane-1", "corr-4").expect("the slot is free");
        assert!(
            waiters.park("pane-1", "corr-4").is_none(),
            "the second ask must not park"
        );
        // Another pane on the same correlation is a different question.
        assert!(waiters.park("pane-2", "corr-4").is_some());
        drop(first);
        assert!(waiters.park("pane-1", "corr-4").is_some());
    }
}
