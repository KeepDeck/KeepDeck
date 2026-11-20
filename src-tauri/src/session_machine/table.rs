//! The session table: the owner of every process handle. A process is handed
//! over by being inserted here — under the table's lock, so the insert and
//! the app's exiting flag cannot cross — and the table outlives the sessions
//! machine: at app exit it stops everyone in it, whether the machine is still
//! there or not. Every process the spawn door starts has an owner until it
//! exits.

use keepdeck_lifecycle::ids::SessionId;
use keepdeck_pty::PtySession;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How often the shared exit wait checks again.
const SHUTDOWN_POLL: Duration = Duration::from_millis(25);

#[derive(Default)]
struct Inner {
    sessions: HashMap<SessionId, Arc<PtySession>>,
    next: u64,
    exiting: bool,
}

#[derive(Default)]
pub struct Table {
    inner: Mutex<Inner>,
}

impl Table {
    /// Take the process over under a new id — never one used before in this
    /// launch. Refused, the process handed back, when the app is exiting: the
    /// door stops it itself.
    pub fn insert(&self, session: PtySession) -> Result<SessionId, PtySession> {
        let mut inner = self.inner.lock().expect("session table");
        if inner.exiting {
            return Err(session);
        }
        inner.next += 1;
        let id = SessionId(inner.next);
        inner.sessions.insert(id, Arc::new(session));
        Ok(id)
    }

    pub fn get(&self, id: SessionId) -> Option<Arc<PtySession>> {
        self.inner.lock().expect("session table").sessions.get(&id).cloned()
    }

    /// The process exited: the table lets its handle go.
    pub fn remove(&self, id: SessionId) {
        self.inner.lock().expect("session table").sessions.remove(&id);
    }

    /// The app is going: stop everyone — one TERM each, one shared wait, a
    /// KILL for whatever is left. The final exit is not confirmed.
    pub fn shutdown(&self, grace: Duration) {
        let sessions: Vec<Arc<PtySession>> = {
            let mut inner = self.inner.lock().expect("session table");
            inner.exiting = true;
            inner.sessions.drain().map(|(_, session)| session).collect()
        };
        if sessions.is_empty() {
            return;
        }
        log::info!("shutdown: stopping {} session(s) of the session table", sessions.len());
        for session in &sessions {
            let _ = session.signal_stop();
        }
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline && sessions.iter().any(|session| !session.has_exited()) {
            thread::sleep(SHUTDOWN_POLL);
        }
        for session in &sessions {
            session.force_stop();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use keepdeck_pty::{PtyEvent, PtySpec, TermSize};

    fn sleeper(script: &str) -> (PtySession, keepdeck_pty::Consumer) {
        PtySession::spawn(PtySpec {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: Vec::new(),
            env_defaults: Vec::new(),
            cwd: None,
            size: TermSize::default(),
        })
        .expect("spawn sh")
    }

    fn exited(events: &keepdeck_pty::Consumer, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            match events.recv_timeout(Duration::from_millis(50)) {
                Some(PtyEvent::Exited(_)) => return true,
                _ => continue,
            }
        }
        false
    }

    #[test]
    fn ids_are_never_reused_and_an_exited_session_lets_its_handle_go() {
        let table = Table::default();
        let (first, _a) = sleeper("sleep 30");
        let (second, _b) = sleeper("sleep 30");
        let one = table.insert(first).ok().unwrap();
        table.remove(one);
        let two = table.insert(second).ok().unwrap();
        assert_ne!(one, two);
        assert!(table.get(one).is_none());
        table.shutdown(Duration::from_millis(200));
    }

    #[test]
    fn at_exit_the_table_stops_everyone_and_takes_no_one_new() {
        let table = Table::default();
        let (polite, polite_events) = sleeper("sleep 30");
        let (stubborn, stubborn_events) = sleeper("trap '' TERM; sleep 30");
        table.insert(polite).ok().unwrap();
        table.insert(stubborn).ok().unwrap();
        table.shutdown(Duration::from_millis(300));
        assert!(exited(&polite_events, Duration::from_secs(5)));
        assert!(exited(&stubborn_events, Duration::from_secs(5)), "the TERM-deaf one is killed");
        let (late, late_events) = sleeper("sleep 30");
        let refused = table.insert(late).expect_err("refused while exiting");
        refused.force_stop();
        assert!(exited(&late_events, Duration::from_secs(5)), "the door stops what the table refused");
    }
}
