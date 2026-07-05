//! Kill must take the whole process tree, not just the direct child — a run
//! command's `&`-backgrounded process outliving its pane is a leak. Real PTYs
//! and real processes: these tests exercise the group-signal path end to end.

#![cfg(unix)]

use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use keepdeck_pty::{PtyEvent, PtySession, PtySpec, TermSize};

/// Accumulate PTY output until `pattern` shows up, or panic at `deadline`.
fn read_until(events: &Receiver<PtyEvent>, pattern: &str, deadline: Duration) -> String {
    let started = Instant::now();
    let mut seen = String::new();
    while started.elapsed() < deadline {
        match events.recv_timeout(Duration::from_millis(200)) {
            Ok(PtyEvent::Output(bytes)) => {
                seen.push_str(&String::from_utf8_lossy(&bytes));
                if seen.contains(pattern) {
                    return seen;
                }
            }
            Ok(PtyEvent::Exited(info)) => {
                panic!("child exited ({info:?}) before {pattern:?}; output: {seen}")
            }
            Err(_) => {}
        }
    }
    panic!("timed out waiting for {pattern:?}; output so far: {seen}");
}

/// Wait for the final `Exited` event, or panic at `deadline`.
fn wait_exit(events: &Receiver<PtyEvent>, deadline: Duration) {
    let started = Instant::now();
    while started.elapsed() < deadline {
        if let Ok(PtyEvent::Exited(_)) = events.recv_timeout(Duration::from_millis(200)) {
            return;
        }
    }
    panic!("timed out waiting for the exit event");
}

/// True while `pid` is signalable (exists, possibly a zombie).
fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 probes existence without delivering anything.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn spawn_sh(script: &str) -> (PtySession, Receiver<PtyEvent>) {
    PtySession::spawn(PtySpec {
        command: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        env: Vec::new(),
        cwd: None,
        size: TermSize::default(),
    })
    .expect("spawn sh")
}

#[test]
fn kill_reaches_backgrounded_children() {
    // The shell prints the background child's pid, then blocks in `wait` —
    // exactly the shape of a run preset that forks a helper.
    let (session, events) = spawn_sh("sleep 30 & echo \"BG=$!\"; wait");
    let output = read_until(&events, "BG=", Duration::from_secs(5));

    let bg_pid: i32 = output
        .split("BG=")
        .nth(1)
        .and_then(|rest| {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
        .expect("background pid in output");
    assert!(alive(bg_pid), "background child should be running before kill");

    session.kill().expect("kill");
    wait_exit(&events, Duration::from_secs(5));

    // The group signal must have reached the background child, not just the
    // shell. Give the kernel a beat to make it observable.
    let started = Instant::now();
    while alive(bg_pid) && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(bg_pid), "background child leaked past kill()");
}

#[test]
fn kill_escalates_to_sigkill_for_term_immune_trees() {
    // A shell that swallows SIGTERM stands in for a misbehaving process; only
    // the 3s SIGKILL escalation can end it.
    let (session, events) = spawn_sh("trap '' TERM; echo READY; sleep 30");
    read_until(&events, "READY", Duration::from_secs(5));

    session.kill().expect("kill");
    // Exit arrives only after the ~3s grace period; 8s leaves CI headroom.
    wait_exit(&events, Duration::from_secs(8));
}
