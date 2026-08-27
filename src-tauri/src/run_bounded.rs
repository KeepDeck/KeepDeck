//! Bounded, non-interactive runs of child processes: the discipline, owned
//! once.
//!
//! Everything here exists because a child that misbehaves must cost the app
//! nothing — not a deadlock, not a lost answer, not a parked thread. The
//! rules were learned on `--version` probes and generalize to any
//! fire-and-tell-me-what-you-said call:
//!
//! - Output goes to a temporary FILE, not a pipe. A pipe holds 64 KB and
//!   then blocks the writer, and nothing drains it while the poll loop runs
//!   — so a program whose output says more than that would deadlock until
//!   the deadline killed it. Worse, `wait_with_output` waits for the pipe to
//!   CLOSE, which a grandchild holding the inherited write end can put off
//!   forever — parking a pool thread with no deadline on it. A file has
//!   neither property.
//! - ONE handle, cloned — not two `reopen()`s. `reopen` opens the path
//!   again, which makes a separate file description with its own offset, so
//!   whichever stream wrote second started at byte 0 and erased the other.
//!   `try_clone` shares one description, so stdout and stderr interleave.
//! - The wait is bounded, because a program that never exits would
//!   otherwise hold a pool thread for the life of the app. Nothing waits on
//!   these answers, but "nothing waits" is not "anything goes".
//! - The read-back is through the descriptor already held rather than by
//!   re-opening the path — the same rule the inbox follows, and for the same
//!   reason: a path resolved twice can resolve to two different things.

use std::process::Command;
use std::time::{Duration, Instant};

/// What a bounded run came back with: whether the child exited 0 within the
/// budget, and up to `max_bytes` of what it said on either stream. A caller
/// that only parses output may ignore `success` (a banner printed by a
/// failing run is still the answer to "which protocol is this"); a caller
/// that asked for an EFFECT reads it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BoundedOutput {
    pub(crate) success: bool,
    pub(crate) said: Vec<u8>,
}

/// Run `command` with its stdin closed and both output streams captured into
/// one temporary file; wait up to `timeout` (polling every `poll`), kill on
/// expiry, and return up to `max_bytes` of what it said on either stream.
///
/// The two failures are told APART, because they mean opposite things to a
/// caller: [`RunFailure::Refused`] is "this never started" (a bad argument,
/// a NUL in the environment, a missing binary), answered in microseconds,
/// while [`RunFailure::TimedOut`] is "it started and would not stop". A
/// caller that reports the second for the first tells the reader to look for
/// a hang that never happened. Lossy by construction: a program that emits one byte of
/// Latin-1, or a multi-byte character straddling the cap, must not cost the
/// output printed before it — `read_to_string` would have failed the whole
/// run on either.
#[derive(Debug)]
pub(crate) enum RunFailure {
    /// The child never started, or its own plumbing could not be built.
    Refused(String),
    /// It started and did not finish inside the budget; it has been killed.
    TimedOut,
}

pub(crate) fn run_bounded(
    command: &mut Command,
    timeout: Duration,
    poll: Duration,
    max_bytes: u64,
) -> Result<BoundedOutput, RunFailure> {
    let refused = |e: std::io::Error| RunFailure::Refused(e.to_string());
    let mut sink = tempfile::NamedTempFile::new().map_err(refused)?;
    // One description, shared: see the module comment on `reopen` vs
    // `try_clone`.
    let out = sink.reopen().map_err(refused)?;
    let err = out.try_clone().map_err(refused)?;
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(refused)?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(poll),
            // Out of time, or the wait itself failed — which says nothing
            // about the child, so it may well still be running. One exit, so
            // the kill cannot be right on one path and missing on the other:
            // that is exactly how a process was left behind here.
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunFailure::TimedOut);
            }
        }
    };
    use std::io::{Read as _, Seek as _};
    sink.as_file_mut().rewind().map_err(refused)?;
    let mut said = Vec::new();
    sink.as_file()
        .take(max_bytes)
        .read_to_end(&mut said)
        .map_err(refused)?;
    Ok(BoundedOutput {
        success: status.success(),
        said,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn sh(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }

    #[test]
    fn captures_what_a_timely_program_says() {
        let mut command = sh("echo out; echo err >&2");
        let output = run_bounded(
            &mut command,
            Duration::from_secs(5),
            Duration::from_millis(5),
            8 * 1024,
        )
        .expect("a timely sh answers");
        assert!(output.success);
        let text = String::from_utf8_lossy(&output.said);
        assert!(text.contains("out"), "stdout lost: {text:?}");
        assert!(text.contains("err"), "stderr lost: {text:?}");
    }

    #[test]
    fn a_program_that_never_exits_is_reported_as_timed_out() {
        let mut command = sh("sleep 30");
        let failure = run_bounded(
            &mut command,
            Duration::from_millis(150),
            Duration::from_millis(10),
            8 * 1024,
        )
        .expect_err("a sleeping program must not answer");
        assert!(
            matches!(failure, RunFailure::TimedOut),
            "a hang must not read as a refusal: {failure:?}",
        );
    }

    #[test]
    fn the_cap_truncates_rather_than_fails() {
        let mut command = sh("echo out; yes x | head -c 100000");
        let output = run_bounded(
            &mut command,
            Duration::from_secs(5),
            Duration::from_millis(5),
            1024,
        )
        .expect("output under the deadline");
        assert_eq!(output.said.len(), 1024);
    }

    #[test]
    fn a_program_that_cannot_spawn_is_reported_as_refused() {
        // The distinction that matters to whoever reads the message: this
        // never started, so nobody should go looking for a hang.
        let mut command = Command::new("/nonexistent/keepdeck/nothing");
        command.env("PATH", OsStr::new("/usr/bin:/bin"));
        let failure = run_bounded(
            &mut command,
            Duration::from_secs(1),
            Duration::from_millis(5),
            8 * 1024,
        )
        .expect_err("a missing program cannot answer");
        assert!(
            matches!(failure, RunFailure::Refused(_)),
            "a refusal must not read as a hang: {failure:?}",
        );
    }
}
