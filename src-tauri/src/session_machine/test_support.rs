//! Real terminals for the session table's and machine's tests: a shell in a
//! PTY, and the pids its script prints.

use keepdeck_pty::{Consumer, PtyEvent, PtySession, PtySpec, TermSize};
use std::time::{Duration, Instant};

/// `/bin/sh -c script` in a fresh PTY.
pub(super) fn sleeper(script: &str) -> (PtySession, Consumer) {
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

/// The `PID=<n>` a test script printed first.
pub(super) fn first_pid(events: &Consumer) -> u32 {
    named_pid(events, &mut String::new(), "PID")
}

/// The `<name>=<n>` a test script printed, waiting for it. `seen` is the
/// output read so far from this terminal, kept for the next ask.
pub(super) fn named_pid(events: &Consumer, seen: &mut String, name: &str) -> u32 {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if let Some(pid) = pid_after(seen, name) {
            return pid;
        }
        if let Some(PtyEvent::Output(bytes)) = events.recv_timeout(Duration::from_millis(50)) {
            seen.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    panic!("no {name} printed: {seen}");
}

/// The `<name>=<n>` in `seen`, once its line has ended: a pid split across two
/// reads is not a pid yet.
pub(super) fn pid_after(seen: &str, name: &str) -> Option<u32> {
    let rest = seen.split(format!("{name}=").as_str()).nth(1)?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    rest[digits.len()..].starts_with(['\r', '\n']).then(|| digits.parse().ok())?
}
