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

/// The `<name>=<n>` a line of `seen` begins with, once that line has ended: a
/// pid split across two reads is not a pid yet. Matched at a line's start,
/// because one name can end another — `WHOOK=` holds `HOOK=` — and the
/// processes print in whichever order they happen to run.
pub(super) fn pid_after(seen: &str, name: &str) -> Option<u32> {
    let prefix = format!("{name}=");
    let ended = &seen[..seen.rfind('\n').map_or(0, |end| end + 1)];
    ended
        .lines()
        .find_map(|line| line.trim_end_matches('\r').strip_prefix(prefix.as_str())?.parse().ok())
}

#[test]
fn a_pid_is_read_by_its_own_name_from_a_whole_line() {
    assert_eq!(pid_after("WHOOK=9\r\nHOOK=5\r\n", "HOOK"), Some(5));
    assert_eq!(pid_after("HOOK=5", "HOOK"), None, "a line not ended yet");
    assert_eq!(pid_after("WHOOK=9\r\n", "HOOK"), None);
}
