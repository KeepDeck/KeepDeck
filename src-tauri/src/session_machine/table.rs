//! The session table: the owner of every process handle. A process is handed
//! over by being inserted here — under the table's lock, so the insert and
//! the app's exiting flag cannot cross — and the table outlives the sessions
//! machine: at app exit it stops everyone in it, whether the machine is still
//! there or not. Every process the spawn door starts has an owner until it
//! exits.
//!
//! It also answers whose a process is. Whoever speaks for a pane — a reporter
//! over the bridge, an MCP client over the socket — is checked against the
//! terminal that is that pane's now ([`Table::pane_of`]); a terminal that is
//! no pane's speaks for nobody.

use keepdeck_lifecycle::domain::ids::{PaneId, SessionId};
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
    /// pane → the session that is its terminal now. A restart re-points it
    /// before the old session's exit is reaped, so removal only clears an
    /// entry that still names the session going away.
    panes: HashMap<PaneId, SessionId>,
    /// pane → the process its reports are pinned to (the webview's binding
    /// ledger, src/app/paneAttribution.ts). Its children count as the pane's
    /// too — see [`PtySession::hosts`].
    vouched: HashMap<PaneId, u32>,
    next: u64,
    exiting: bool,
}

#[derive(Default)]
pub struct Table {
    inner: Mutex<Inner>,
}

impl Table {
    /// Take the process over under a new id — never one used before in this
    /// launch — as the terminal of `pane`, when it is one. Refused, the
    /// process handed back, when the app is exiting: the door stops it
    /// itself.
    pub fn insert(&self, session: PtySession, pane: Option<PaneId>) -> Result<SessionId, PtySession> {
        let mut inner = self.inner.lock().expect("session table");
        if inner.exiting {
            return Err(session);
        }
        inner.next += 1;
        let id = SessionId(inner.next);
        inner.sessions.insert(id, Arc::new(session));
        if let Some(pane) = pane {
            inner.panes.insert(pane, id);
        }
        Ok(id)
    }

    pub fn get(&self, id: SessionId) -> Option<Arc<PtySession>> {
        self.inner.lock().expect("session table").sessions.get(&id).cloned()
    }

    /// The process exited: the table lets its handle go, and with it the pane
    /// it was the terminal of, and that pane's pin — the webview's own word
    /// that the pin is gone may never arrive.
    pub fn remove(&self, id: SessionId) {
        let mut inner = self.inner.lock().expect("session table");
        inner.sessions.remove(&id);
        let Inner { panes, vouched, .. } = &mut *inner;
        panes.retain(|pane, session| {
            let stays = *session != id;
            if !stays {
                vouched.remove(pane);
            }
            stays
        });
    }

    /// The pane whose terminal process `pid` belongs to
    /// ([`PtySession::hosts`]), or None when it belongs to none — a process
    /// of no pane, a daemon some pane's agent started and left behind, or one
    /// asking after its pane's terminal is gone. At most one can answer: a
    /// process sits in one session, and so does the parent of one that
    /// detached.
    pub fn pane_of(&self, pid: u32) -> Option<PaneId> {
        let panes: Vec<(PaneId, Arc<PtySession>, Option<u32>)> = {
            let inner = self.inner.lock().expect("session table");
            inner
                .panes
                .iter()
                .filter_map(|(pane, id)| Some((*pane, inner.sessions.get(id)?.clone(), inner.vouched.get(pane).copied())))
                .collect()
        };
        // Outside the lock: the kernel is asked per terminal, and the table's
        // lock is never held across a syscall.
        panes.into_iter().find_map(|(pane, session, vouched)| session.hosts(pid, vouched).then_some(pane))
    }

    /// Record the process `pane`'s reports are pinned to, or forget it.
    pub fn vouch(&self, pane: PaneId, pid: Option<u32>) {
        let mut inner = self.inner.lock().expect("session table");
        match pid {
            Some(pid) => inner.vouched.insert(pane, pid),
            None => inner.vouched.remove(&pane),
        };
    }

    /// The app is going: stop everyone — one TERM each, one shared wait, a
    /// KILL for whatever is left. The final exit is not confirmed.
    ///
    /// Closing a PTY does not end what runs behind it. An agent CLI that owns
    /// its own children survives the hangup, and one that outlives the app
    /// keeps whatever it had open — codex holds a writer on its rollout file
    /// and then refuses to resume a thread "another writer" holds, so the
    /// leaked process is what stops the NEXT launch restoring that pane. The
    /// wait is shared: a session at a time would cost the grace period per
    /// session, and a deck of eight agents would hang the quit for half a
    /// minute.
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
        let stubborn = sessions.iter().filter(|session| !session.has_exited()).count();
        for session in &sessions {
            session.force_stop();
        }
        if stubborn > 0 {
            log::warn!("shutdown: {stubborn} session(s) had to be killed");
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
        let one = table.insert(first, None).ok().unwrap();
        table.remove(one);
        let two = table.insert(second, None).ok().unwrap();
        assert_ne!(one, two);
        assert!(table.get(one).is_none());
        table.shutdown(Duration::from_millis(200));
    }

    #[test]
    fn at_exit_the_table_stops_everyone_and_takes_no_one_new() {
        let table = Table::default();
        let (polite, polite_events) = sleeper("sleep 30");
        let (stubborn, stubborn_events) = sleeper("trap '' TERM; sleep 30");
        table.insert(polite, None).ok().unwrap();
        table.insert(stubborn, None).ok().unwrap();
        table.shutdown(Duration::from_millis(300));
        assert!(exited(&polite_events, Duration::from_secs(5)));
        assert!(exited(&stubborn_events, Duration::from_secs(5)), "the TERM-deaf one is killed");
        let (late, late_events) = sleeper("sleep 30");
        let refused = table.insert(late, None).expect_err("refused while exiting");
        refused.force_stop();
        assert!(exited(&late_events, Duration::from_secs(5)), "the door stops what the table refused");
    }

    #[test]
    fn at_exit_the_sessions_are_waited_for_together_not_one_after_another() {
        // Quitting must not cost the grace period per pane. Two agents that
        // both go on SIGTERM have to be gone in about the time one takes.
        let table = Table::default();
        let (first, first_events) = sleeper("sleep 30");
        let (second, second_events) = sleeper("sleep 30");
        table.insert(first, None).ok().unwrap();
        table.insert(second, None).ok().unwrap();

        // A grace far longer than anything a `sleep` takes to die, so the
        // claim rests on the GAP rather than on absolute timing.
        let started = Instant::now();
        table.shutdown(Duration::from_secs(30));
        let waited = started.elapsed();

        assert!(exited(&first_events, Duration::from_secs(5)));
        assert!(exited(&second_events, Duration::from_secs(5)));
        assert!(waited < Duration::from_secs(5), "waited {waited:?} of a 30s grace for two prompt exits — the wait is not shared");
    }

    #[test]
    fn a_process_belongs_to_the_pane_whose_current_terminal_hosts_it() {
        let table = Table::default();
        let pane = PaneId(1);
        let (old, old_events) = sleeper("echo PID=$$; sleep 30");
        let old_pid = first_pid(&old_events);
        let old_id = table.insert(old, Some(pane)).ok().unwrap();
        assert_eq!(table.pane_of(old_pid), Some(pane));
        // This test process runs in no pane's terminal.
        assert_eq!(table.pane_of(std::process::id()), None);

        // A restart re-points the pane before the old terminal is reaped; the
        // old one's late removal must not take the new one's entry with it.
        let (new, new_events) = sleeper("echo PID=$$; sleep 30");
        let new_pid = first_pid(&new_events);
        table.insert(new, Some(pane)).ok().unwrap();
        table.remove(old_id);
        assert_eq!(table.pane_of(new_pid), Some(pane));
        assert_eq!(table.pane_of(old_pid), None, "the retired terminal is no pane's");

        // A terminal that is no pane's makes its processes nobody's.
        let (plain, plain_events) = sleeper("echo PID=$$; sleep 30");
        let plain_pid = first_pid(&plain_events);
        table.insert(plain, None).ok().unwrap();
        assert_eq!(table.pane_of(plain_pid), None);
        table.shutdown(Duration::from_millis(200));
    }

    #[test]
    fn a_pane_counts_the_children_of_the_process_its_reports_are_pinned_to() {
        // opencode 2.x: the agent (`serve`) leaves the terminal's session, and
        // the MCP server it starts is its child — the pane's only through the
        // pin the webview hands down.
        let table = Table::default();
        let pane = PaneId(1);
        let (terminal, events) = sleeper(
            "perl -e 'use POSIX; setsid(); print \"AGENT=$$\\n\"; \
               if (my $k = fork()) { sleep 30 } else { print \"PID=$$\\n\"; sleep 30 }' & wait",
        );
        let mut seen = String::new();
        let agent = named_pid(&events, &mut seen, "AGENT");
        let server = named_pid(&events, &mut seen, "PID");
        let id = table.insert(terminal, Some(pane)).ok().unwrap();

        assert_eq!(table.pane_of(server), None, "not before the pane vouches");
        table.vouch(pane, Some(agent));
        assert_eq!(table.pane_of(server), Some(pane));
        table.vouch(pane, None);
        assert_eq!(table.pane_of(server), None, "nor after the pin is dropped");

        // The pin goes with its terminal, even when the webview never says so.
        table.vouch(pane, Some(agent));
        table.remove(id);
        assert!(table.inner.lock().unwrap().vouched.is_empty());

        for pid in [server, agent] {
            // SAFETY: processes this test started; they left the terminal's
            // group, so its shutdown would not reach them.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
        table.shutdown(Duration::from_millis(200));
    }

    /// The `PID=<n>` a test script printed first.
    fn first_pid(events: &keepdeck_pty::Consumer) -> u32 {
        named_pid(events, &mut String::new(), "PID")
    }

    /// The `<name>=<n>` a test script printed, waiting for it. `seen` is the
    /// output read so far from this terminal, kept for the next ask.
    fn named_pid(events: &keepdeck_pty::Consumer, seen: &mut String, name: &str) -> u32 {
        let started = Instant::now();
        let marker = format!("{name}=");
        while started.elapsed() < Duration::from_secs(5) {
            if let Some(rest) = seen.split(marker.as_str()).nth(1) {
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                if rest[digits.len()..].starts_with(['\r', '\n']) {
                    return digits.parse().expect("a pid");
                }
            }
            if let Some(PtyEvent::Output(bytes)) = events.recv_timeout(Duration::from_millis(50)) {
                seen.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        panic!("no {name} printed: {seen}");
    }
}
