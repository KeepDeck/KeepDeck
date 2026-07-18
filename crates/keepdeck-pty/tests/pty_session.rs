//! Integration tests for [`PtySession`] — they spawn real processes in a PTY and
//! assert the streamed events. Unix-only commands (`echo`, `sh`, `cat`).

use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use keepdeck_pty::{ExitInfo, PtyEvent, PtySession, PtySpec, TermSize};

fn spec(command: &str, args: &[&str]) -> PtySpec {
    PtySpec {
        command: command.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: Vec::new(),
        env_defaults: Vec::new(),
        cwd: None,
        size: TermSize::default(),
    }
}

/// Drain events until `Exited` (or timeout), returning accumulated output and the
/// exit info if the session ended in time.
fn run_to_exit(rx: &Receiver<PtyEvent>, timeout: Duration) -> (Vec<u8>, Option<ExitInfo>) {
    let mut out = Vec::new();
    let deadline = Instant::now() + timeout;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(remaining) {
            Ok(PtyEvent::Output(bytes)) => out.extend_from_slice(&bytes),
            Ok(PtyEvent::Exited(info)) => return (out, Some(info)),
            Err(_) => break,
        }
    }
    (out, None)
}

#[test]
fn streams_command_output_then_exits() {
    let (_session, rx) = PtySession::spawn(spec("echo", &["keepdeck"])).expect("spawn echo");
    let (out, exit) = run_to_exit(&rx, Duration::from_secs(5));

    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("keepdeck"), "output was: {text:?}");

    let exit = exit.expect("should report an exit");
    assert!(exit.success, "echo should succeed");
    assert_eq!(exit.code, Some(0));
}

#[test]
fn reports_nonzero_exit_code() {
    let (_session, rx) = PtySession::spawn(spec("sh", &["-c", "exit 3"])).expect("spawn sh");
    let (_out, exit) = run_to_exit(&rx, Duration::from_secs(5));

    let exit = exit.expect("should report an exit");
    assert!(!exit.success);
    assert_eq!(exit.code, Some(3));
}

#[test]
fn echoes_written_input() {
    // `cat` re-emits whatever is written to its stdin.
    let (session, rx) = PtySession::spawn(spec("cat", &[])).expect("spawn cat");
    session.write(b"ping\n").expect("write to pty");

    let mut seen = String::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(PtyEvent::Output(bytes)) => {
                seen.push_str(&String::from_utf8_lossy(&bytes));
                if seen.contains("ping") {
                    break;
                }
            }
            Ok(PtyEvent::Exited(_)) => break,
            Err(_) => {}
        }
    }
    assert!(seen.contains("ping"), "expected echoed input, saw: {seen:?}");

    session.kill().expect("kill cat");
    let (_out, exit) = run_to_exit(&rx, Duration::from_secs(5));
    assert!(exit.is_some(), "session should terminate after kill");
}

#[test]
fn resize_succeeds_on_live_session() {
    let (session, _rx) = PtySession::spawn(spec("cat", &[])).expect("spawn cat");
    session.resize(120, 40).expect("resize a live pty should succeed");
}

#[test]
fn kill_lands_while_a_write_is_blocked_on_a_hung_child() {
    use std::sync::Arc;

    // `sleep` never reads stdin: the PTY input buffer fills and a large write
    // blocks holding the writer lock. Kill must not queue behind it — one
    // shared lock here turned a hung agent into an uncloseable pane.
    let (session, rx) = PtySession::spawn(spec("sleep", &["30"])).expect("spawn sleep");
    let session = Arc::new(session);

    let writer = session.clone();
    std::thread::spawn(move || {
        // Far larger than any PTY input buffer, so write_all stays blocked
        // until the child dies; the thread then ends on the write error.
        let flood = vec![b'x'; 8 * 1024 * 1024];
        let _ = writer.write(&flood);
    });
    std::thread::sleep(Duration::from_millis(300));

    session.kill().expect("kill must not block behind the write");
    let (_out, exit) = run_to_exit(&rx, Duration::from_secs(10));
    let exit = exit.expect("child should exit after kill despite the blocked write");
    assert!(!exit.success, "sleep was killed, not completed");
}

#[test]
fn child_environment_selects_a_utf8_locale() {
    // Children must always end up under a UTF-8 locale: inherited from the
    // host env when it has one, injected by the spawn otherwise (GUI-launched
    // apps get launchd's LANG-less env, where pbcopy in a pane would garble
    // non-ASCII text as MacRoman).
    let (_session, rx) = PtySession::spawn(spec(
        "sh",
        &["-c", r#"printf '<%s|%s|%s>' "$LC_ALL" "$LC_CTYPE" "$LANG""#],
    ))
    .expect("spawn sh");
    let (out, exit) = run_to_exit(&rx, Duration::from_secs(5));

    assert!(exit.expect("should exit").success);
    let text = String::from_utf8_lossy(&out).to_lowercase().replace('-', "");
    assert!(
        text.contains("utf8"),
        "child locale vars carry no UTF-8: {text:?}"
    );
}

#[test]
fn missing_command_is_handled() {
    // Either the spawn errors outright, or the child terminates non-successfully;
    // both are acceptable — what matters is we don't hang or panic.
    match PtySession::spawn(spec("keepdeck-no-such-binary-xyz", &[])) {
        Err(_) => {}
        Ok((_session, rx)) => {
            let (_out, exit) = run_to_exit(&rx, Duration::from_secs(5));
            let exit = exit.expect("a missing command should still terminate");
            assert!(!exit.success, "a missing command must not report success");
        }
    }
}

