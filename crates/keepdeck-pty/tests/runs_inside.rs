//! Which processes run in a pane's terminal — the question the bridge asks
//! before letting a report speak for a pane. Real PTYs and real processes:
//! the answer is the kernel's, so a fake would only test the fake.

#![cfg(unix)]

use std::time::{Duration, Instant};

use keepdeck_pty::{Consumer, PtyEvent, PtySession, PtySpec, TermSize};

/// Accumulate output until every `NAME=<pid>` in `names` has appeared.
fn read_pids(events: &Consumer, names: &[&str]) -> Vec<u32> {
    let started = Instant::now();
    let mut seen = String::new();
    while started.elapsed() < Duration::from_secs(5) {
        let pids: Option<Vec<u32>> = names.iter().map(|name| pid_after(&seen, name)).collect();
        if let Some(pids) = pids {
            return pids;
        }
        match events.recv_timeout(Duration::from_millis(200)) {
            Some(PtyEvent::Output(bytes)) => seen.push_str(&String::from_utf8_lossy(&bytes)),
            Some(PtyEvent::Exited(info)) => panic!("exited ({info:?}); output: {seen}"),
            None => {}
        }
    }
    panic!("timed out waiting for {names:?}; output so far: {seen}");
}

fn pid_after(output: &str, name: &str) -> Option<u32> {
    let rest = output.split(&format!("{name}=")).nth(1)?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    // A pid split across two reads is not a pid yet.
    rest[digits.len()..].starts_with(['\r', '\n']).then(|| digits.parse().ok())?
}

fn spawn_sh(script: &str) -> (PtySession, Consumer) {
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

#[test]
fn a_child_runs_inside_and_a_detached_one_does_not() {
    // A backgrounded child stays in the terminal's session — the shape of a
    // hook or a tool call. The perl one leaves it with setsid(2), the way an
    // agent's daemon does; it then inherits everything but the terminal.
    let (session, events) = spawn_sh(
        "echo SELF=$$; sleep 30 & echo CHILD=$!; \
         perl -e 'use POSIX; setsid(); print \"DETACHED=$$\\n\"; sleep 30' & wait",
    );
    let pids = read_pids(&events, &["SELF", "CHILD", "DETACHED"]);
    let (own, child, detached) = (pids[0], pids[1], pids[2]);

    assert!(session.runs_inside(own), "the terminal's own leader");
    assert!(session.runs_inside(child), "a child that stayed");
    assert!(!session.runs_inside(detached), "a child that left with setsid");
    assert!(!session.runs_inside(u32::MAX), "no such process");
    assert!(!session.runs_inside(0), "pid 0 names no process");

    // Another terminal's leader is not this one's.
    let (other, other_events) = spawn_sh("echo SELF=$$; sleep 30");
    let stranger = read_pids(&other_events, &["SELF"])[0];
    assert!(!session.runs_inside(stranger));
    assert!(other.runs_inside(stranger));

    // The detached process is in no pane's tree at all; take it down by hand.
    // SAFETY: a process this test started.
    unsafe { libc::kill(detached as i32, libc::SIGKILL) };
    session.force_stop();
    other.force_stop();
}

#[test]
fn nothing_runs_inside_a_terminal_whose_child_is_gone() {
    // Once the leader is reaped its id may be handed to a stranger, so the
    // answer must stop being yes even for a process still holding that sid.
    let (session, events) = spawn_sh("echo SELF=$$; exit 0");
    let own = read_pids(&events, &["SELF"])[0];
    let started = Instant::now();
    while !session.has_exited() && started.elapsed() < Duration::from_secs(5) {
        let _ = events.recv_timeout(Duration::from_millis(100));
    }
    assert!(session.has_exited());
    assert!(!session.runs_inside(own));
}
