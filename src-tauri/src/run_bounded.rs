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
/// `None` covers every failure — spawn refused, wait errored, deadline
/// expired — and reads as "the program said nothing we can use", never as an
/// error to surface. Lossy by construction: a program that emits one byte of
/// Latin-1, or a multi-byte character straddling the cap, must not cost the
/// output printed before it — `read_to_string` would have failed the whole
/// run on either.
pub(crate) fn run_bounded(
    command: &mut Command,
    timeout: Duration,
    poll: Duration,
    max_bytes: u64,
) -> Option<BoundedOutput> {
    let mut sink = tempfile::NamedTempFile::new().ok()?;
    // One description, shared: see the module comment on `reopen` vs
    // `try_clone`.
    let out = sink.reopen().ok()?;
    let err = out.try_clone().ok()?;
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .ok()?;
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
                return None;
            }
        }
    };
    use std::io::{Read as _, Seek as _};
    sink.as_file_mut().rewind().ok()?;
    let mut said = Vec::new();
    sink.as_file().take(max_bytes).read_to_end(&mut said).ok()?;
    Some(BoundedOutput {
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
    fn a_program_that_never_exits_yields_none() {
        let mut command = sh("sleep 30");
        let output = run_bounded(
            &mut command,
            Duration::from_millis(150),
            Duration::from_millis(10),
            8 * 1024,
        );
        assert_eq!(output, None);
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
    fn a_program_that_cannot_spawn_yields_none() {
        let mut command = Command::new("/nonexistent/keepdeck/nothing");
        command.env("PATH", OsStr::new("/usr/bin:/bin"));
        assert_eq!(
            run_bounded(
                &mut command,
                Duration::from_secs(1),
                Duration::from_millis(5),
                8 * 1024
            ),
            None
        );
    }
}
