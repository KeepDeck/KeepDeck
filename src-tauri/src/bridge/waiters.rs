//! Holding a connection open while the deck decides what to say.
//!
//! A hook that asks a question cannot be answered by the thread that took the
//! question: the answer comes from the webview, which learns of the question
//! only through the event the route emits. So the route parks on a channel
//! keyed by the question's correlation, and whoever carries the deck's answer
//! back unparks it.
//!
//! The file lane solves the same problem with a file and a poll. This is that
//! rendezvous without the polling — and without the window in which an answer
//! exists on disk but nobody has come for it yet.

use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

/// Everyone currently parked, by correlation.
#[derive(Default)]
pub(super) struct Waiters {
    parked: Mutex<HashMap<String, SyncSender<String>>>,
}

impl Waiters {
    /// Park until an answer for `id` arrives, or `patience` runs out.
    ///
    /// `None` means nobody answered in time. That is the SAME outcome the
    /// file lane produces when a hook stops polling — the deck is told the
    /// answer went uncollected and puts the messages back — so a timeout
    /// here must not look like an empty answer, which means "nothing was
    /// waiting for you" and loses nothing.
    pub(super) fn wait(&self, id: &str, patience: Duration) -> Option<String> {
        // Bounded at one: the answer is sent once, and a sender that finds
        // nobody home must not block on a full queue.
        let (tx, rx) = sync_channel(1);
        self.parked
            .lock()
            .expect("waiters poisoned")
            .insert(id.to_string(), tx);
        let answer = rx.recv_timeout(patience).ok();
        // Unparked either way: a timed-out entry left behind would answer a
        // later question that reused the correlation, and would keep a
        // channel alive for a thread that has already gone.
        self.parked.lock().expect("waiters poisoned").remove(id);
        answer
    }

    /// Hand `body` to whoever is parked on `id`. `false` means nobody was —
    /// the caller still owns the answer and must deliver it the other way.
    pub(super) fn resolve(&self, id: &str, body: String) -> bool {
        let parked = self
            .parked
            .lock()
            .expect("waiters poisoned")
            .remove(id);
        match parked {
            // A full or disconnected channel means the waiter gave up between
            // the lookup and the send: not delivered, and the caller has to
            // hear that rather than assume.
            Some(tx) => tx.try_send(body).is_ok(),
            None => false,
        }
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
        std::thread::spawn(move || {
            // Give the asker time to park; resolve is a no-op before it does.
            for _ in 0..100 {
                if answering.resolve("corr-1", "the answer".into()) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        assert_eq!(
            waiters.wait("corr-1", Duration::from_secs(2)),
            Some("the answer".to_string())
        );
    }

    #[test]
    fn nobody_answering_is_none_rather_than_an_empty_answer() {
        // An empty answer means "nothing was waiting for you" and loses
        // nothing; a timeout means the deck already handed messages over.
        let waiters = Waiters::default();
        assert_eq!(waiters.wait("corr-2", Duration::from_millis(50)), None);
    }

    #[test]
    fn resolving_an_unknown_correlation_reports_that_it_landed_nowhere() {
        let waiters = Waiters::default();
        assert!(!waiters.resolve("nobody-is-here", "answer".into()));
    }

    #[test]
    fn a_timed_out_waiter_leaves_nothing_behind_for_the_next_question() {
        let waiters = Waiters::default();
        assert_eq!(waiters.wait("corr-3", Duration::from_millis(20)), None);
        // The stale entry would have swallowed this one.
        assert!(!waiters.resolve("corr-3", "late".into()));
    }
}
