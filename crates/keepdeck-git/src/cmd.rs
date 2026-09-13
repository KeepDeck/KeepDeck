use std::cell::Cell;
use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use crate::error::GitError;

thread_local! {
    /// Every git process this crate has spawned ON THIS THREAD, counted at
    /// the one boundary that spawns them. Per thread, not per process: the
    /// crate spawns on the caller's thread (the engine's reader threads spawn
    /// nothing), and a caller measuring one read's cost must not see the
    /// processes of whatever else is running — the test harness runs its
    /// tests in parallel, and a process-wide count charged one test's
    /// worktree setup to another's measured read.
    static SPAWNS: Cell<u64> = const { Cell::new(0) };
}

/// How many git processes the crate has spawned so far on the calling thread
/// — a monotonic count, so a caller measures a read's cost as a difference.
/// The unit that matters for a read that fans out per worktree is processes,
/// not seconds: seconds vary with the machine, the count is the design.
pub fn spawns() -> u64 {
    SPAWNS.with(Cell::get)
}

fn count_spawn() {
    SPAWNS.with(|count| count.set(count.get() + 1));
}

/// How long one READ may run. Every read this crate makes answers in
/// milliseconds on a healthy repository, and in seconds on a monorepo; a git
/// that has said nothing in this long is stuck — a hook or a filter waiting
/// on something, a network filesystem gone away — and a caller holding an
/// IPC slot for it forever helps nobody. It is killed, and the caller hears
/// [`GitError::Timeout`]. Provisioning runs on no clock at all
/// ([`run_git_provisioning`]).
pub const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long, after the child has gone, to wait for the last of its stderr.
/// Git's children inherit the pipe, and one that outlives git — a filter
/// script that forked something — keeps it open for as long as it lives;
/// the drain would wait with it. The answer goes out after this much grace
/// with whatever stderr has arrived, and the lingering reader thread ends
/// on its own when the grandchild does.
const STDERR_GRACE: Duration = Duration::from_millis(500);

/// How long a child gets to end on its own once its output was cut at the
/// cap. Our end of the pipe closes with the cut, so a git still writing
/// dies of the broken pipe at once — and a git that had already finished
/// keeps its own exit, failure included. One waiting on something else (a
/// filter, a hook) writes nothing and hears nothing; it is killed after
/// this, and that kill is ours to forgive.
const CAP_GRACE: Duration = Duration::from_millis(250);

/// How much of a failed command's stderr an error carries. The error is
/// shown, logged and sent over IPC; git's failures say what they have to say
/// in the first lines, and a chatty hook could otherwise put a megabyte in
/// each. Cut with a mark, never silently.
pub const STDERR_MAX_BYTES: usize = 2048;

/// Output read under a byte cap: the text up to the cap, cut at the last
/// line break within it so no line arrives half, and whether anything was
/// left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capped {
    pub text: String,
    pub truncated: bool,
}

/// Run `git -C <dir> <args...>` and return its stdout on success.
///
/// This is the single boundary where the crate shells out to the user's `git`;
/// everything else is pure logic over the strings it returns. Args are
/// `AsRef<OsStr>` so callers can pass paths losslessly — a `to_string_lossy`
/// would corrupt a non-UTF-8 path (real on Linux). A non-zero exit becomes
/// [`GitError::Command`] carrying the args and stderr; a git that has not
/// finished within [`GIT_TIMEOUT`] is killed and becomes [`GitError::Timeout`].
///
/// The child runs with [`keepdeck_env::augmented_path`], not the inherited
/// `PATH`: a GUI-launched app gets launchd's stripped `PATH`
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), under which "git" resolves to Apple's
/// copy instead of the user's, and — worse — git's OWN children inherit that
/// `PATH`, so a repo whose config names a bare `git-lfs filter-process`
/// (`filter.lfs.required=true`) fails every checkout with exit 128. Setting
/// `PATH` on the command also directs the program lookup itself (documented
/// std behavior), so both git and its subprocesses resolve like they do in the
/// user's terminal.
pub(crate) fn run_git<I, S>(dir: &Path, args: I) -> Result<String, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let (command, shown) = git_command(dir, args);
    run(command, shown, None, Some(GIT_TIMEOUT)).map(|capped| capped.text)
}

/// Run `git -C <dir> <args...>` with no clock on it — for PROVISIONING:
/// `worktree add` runs the checkout's smudge filters (LFS pulls whole
/// files) and its post-checkout hook, and a large tree on a slow disk takes
/// as long as it takes; killing it at thirty seconds would leave a half-made
/// worktree where the read timeout only drops a stale answer. The rest of
/// the engine still applies — its own process group, the bounded stderr
/// drain — which is what a plain `.output()` never had.
pub(crate) fn run_git_provisioning<I, S>(dir: &Path, args: I) -> Result<String, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let (command, shown) = git_command(dir, args);
    run(command, shown, None, None).map(|capped| capped.text)
}

/// Run `git -C <dir> <args...>` and return its stdout up to `max_bytes`.
///
/// The counterpart of [`run_git`] for commands whose output has no natural
/// bound — a diff of a generated file can run to hundreds of megabytes, and
/// holding every byte before anyone could decide it was too much is not an
/// option. Stdout is read as a stream and the child is killed once the cap
/// is passed. Below the cap this behaves exactly like [`run_git`]. Past the
/// cap, only the exit WE caused is forgiven — a git that failed on its own
/// after writing more than the cap is still a failure, not a long answer.
pub(crate) fn run_git_capped<I, S>(
    dir: &Path,
    args: I,
    max_bytes: usize,
) -> Result<Capped, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let (command, shown) = git_command(dir, args);
    run(command, shown, Some(max_bytes), Some(GIT_TIMEOUT))
}

/// `git -C <dir> <args...>` with the crate's PATH, and the args as an error
/// names them (display-only; the command itself gets the lossless OsStrs).
fn git_command<I, S>(dir: &Path, args: I) -> (Command, Vec<String>)
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<S> = args.into_iter().collect();
    let mut command = Command::new("git");
    command
        .env("PATH", keepdeck_env::augmented_path())
        .arg("-C")
        .arg(dir)
        .args(&args);
    let shown = args
        .iter()
        .map(|a| a.as_ref().to_string_lossy().into_owned())
        .collect();
    (command, shown)
}

/// The one engine under every runner: spawn, stream stdout (under the cap,
/// when there is one), bound the whole thing by `timeout` (when there is
/// one), drain stderr on the side, and kill the child — with its process
/// group — when the cap or the clock says so.
///
/// Both pipes are read on their own threads: reading stdout on this thread
/// would block for as long as a stuck child keeps the pipe open, past any
/// deadline; the threads block instead, and this thread only waits on
/// channels with timeouts. The child leads its own process group so a kill
/// reaches git's children too — a diff driver, a filter, a hook — which a
/// kill of git alone left running, holding the pipes open.
fn run(
    mut command: Command,
    shown: Vec<String>,
    cap: Option<usize>,
    timeout: Option<Duration>,
) -> Result<Capped, GitError> {
    count_spawn();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(GitError::Spawn)?;
    let started = Instant::now();

    let mut stderr = child.stderr.take().expect("stderr was piped");
    let (stderr_tx, stderr_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        let _ = stderr_tx.send(buf);
    });

    let mut stdout = child.stdout.take().expect("stdout was piped");
    let (stdout_tx, stdout_rx) = mpsc::channel();
    // One byte past the cap tells "exactly at the cap" from "more to come".
    let want = cap.map_or(u64::MAX, |cap| cap as u64 + 1);
    std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(cap.unwrap_or(64 * 1024).min(64 * 1024));
        let read = (&mut stdout).take(want).read_to_end(&mut buf);
        let _ = stdout_tx.send((buf, read.err()));
    });

    // Stdout ends with the child (or at the cap) — or the clock runs out.
    let deadline = timeout.map(|timeout| started + timeout);
    let streamed = match deadline {
        Some(deadline) => {
            match stdout_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(streamed) => Some(streamed),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => Some((Vec::new(), None)),
            }
        }
        None => Some(stdout_rx.recv().unwrap_or((Vec::new(), None))),
    };
    let Some((mut buf, read_error)) = streamed else {
        kill_tree(&mut child);
        let _ = child.wait();
        return Err(GitError::Timeout {
            args: shown,
            after: started.elapsed(),
        });
    };

    let truncated = cap.is_some_and(|cap| buf.len() > cap);
    if truncated {
        // Whole lines only: cut at the last line break inside the cap, so the
        // reader never sees a line that stops mid-way. A single line longer
        // than the cap is kept as it is — there is no better place to cut.
        buf.truncate(cap.unwrap_or(buf.len()));
        if let Some(nl) = buf.iter().rposition(|b| *b == b'\n') {
            buf.truncate(nl + 1);
        }
    }
    let answer = Capped {
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
    };

    // The rest is not wanted. The reader thread has closed our end of the
    // pipe by now (see `CAP_GRACE`), so a child still writing ends on the
    // broken pipe; one that has nothing left to say is bound by the clock —
    // a hook it waits on could hold it open indefinitely.
    let bound = if truncated {
        let grace = Instant::now() + CAP_GRACE;
        Some(deadline.map_or(grace, |deadline| deadline.min(grace)))
    } else {
        deadline
    };
    let status = match wait_until(&mut child, bound) {
        Some(status) => status,
        None => {
            kill_tree(&mut child);
            let _ = child.wait();
            if truncated {
                // Ours to forgive: the child was cut off, not failing.
                return Ok(answer);
            }
            return Err(GitError::Timeout {
                args: shown,
                after: started.elapsed(),
            });
        }
    };
    let stderr_bytes = stderr_rx.recv_timeout(STDERR_GRACE).unwrap_or_default();
    if let Some(error) = read_error {
        return Err(GitError::Spawn(error));
    }

    // A death by our closed pipe is ours; any other non-zero exit is the
    // child's own — a git that failed after writing more than the cap is
    // still a failure, not a long answer.
    let cut_off = truncated && died_of_broken_pipe(&status);
    if !cut_off && !status.success() {
        return Err(GitError::Command {
            args: shown,
            status: status.code(),
            stderr: stderr_head(&stderr_bytes),
        });
    }
    Ok(answer)
}

#[cfg(unix)]
fn died_of_broken_pipe(status: &ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt;
    const SIGPIPE: i32 = 13;
    status.signal() == Some(SIGPIPE)
}

#[cfg(not(unix))]
fn died_of_broken_pipe(_status: &ExitStatus) -> bool {
    false
}

/// Wait for the child's exit until `deadline` — plainly, with none; `None`
/// when it is still running then. Polling, not blocking, under a deadline:
/// std has no bounded wait, and the intervals are short enough that a
/// normal exit costs no visible latency.
fn wait_until(child: &mut Child, deadline: Option<Instant>) -> Option<ExitStatus> {
    let Some(deadline) = deadline else {
        return child.wait().ok();
    };
    let mut nap = Duration::from_millis(1);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(nap);
        nap = (nap * 2).min(Duration::from_millis(20));
    }
}

/// Kill the child and everything in its process group. Whether the child
/// was there to kill: `false` means it had already gone, and its own exit
/// counts.
#[cfg(unix)]
fn kill_tree(child: &mut Child) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    // The child leads its group (`process_group(0)` at spawn): the negative
    // pid names the whole group — git and whatever it spawned.
    let group = -(child.id() as i32);
    // SAFETY: `kill(2)` with a pid we own; no pointers, no invariants beyond
    // the pid being ours, which `child.id()` guarantees for a live child.
    let group_signalled = unsafe { kill(group, SIGKILL) } == 0;
    child.kill().is_ok() || group_signalled
}

#[cfg(not(unix))]
fn kill_tree(child: &mut Child) -> bool {
    child.kill().is_ok()
}

/// The head of a failed command's stderr, as the error keeps it: trimmed,
/// cut at [`STDERR_MAX_BYTES`] with a mark when there was more.
fn stderr_head(bytes: &[u8]) -> String {
    if bytes.len() <= STDERR_MAX_BYTES {
        return String::from_utf8_lossy(bytes).trim().to_string();
    }
    let head = String::from_utf8_lossy(&bytes[..STDERR_MAX_BYTES]);
    format!("{} …", head.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// The engine on `sh`, so a test scripts the child's behaviour instead of
    /// needing a repository shaped to provoke it.
    fn sh(script: &str, cap: Option<usize>, timeout: Duration) -> Result<Capped, GitError> {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        run(command, vec!["sh".into(), "-c".into()], cap, Some(timeout))
    }

    #[test]
    fn a_run_on_no_clock_waits_for_the_child_however_long() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 0.5; echo done"]);
        let out = run(command, vec!["sh".into()], None, None).unwrap();
        assert_eq!(out.text, "done\n");
    }

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "keepdeck-git-cmd-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn a_normal_answer_comes_back_whole() {
        let out = sh("printf 'a\\nb\\n'", None, GIT_TIMEOUT).unwrap();
        assert_eq!(out.text, "a\nb\n");
        assert!(!out.truncated);
    }

    #[test]
    fn a_child_that_never_answers_is_killed_at_the_timeout() {
        let started = Instant::now();
        let err = sh("sleep 30", None, Duration::from_millis(200)).unwrap_err();
        assert!(
            matches!(err, GitError::Timeout { .. }),
            "expected a timeout, got {err:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the timeout bounds the call: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_timeout_takes_the_childs_own_children_with_it() {
        // `sleep` is sh's CHILD (a forked one — `&`), so a kill of sh alone
        // would leave it running for its 30 seconds. Its pid lands in a file.
        let dir = scratch("group");
        let pid_file = dir.join("pid");
        let script = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());
        let err = sh(&script, None, Duration::from_millis(300)).unwrap_err();
        assert!(matches!(err, GitError::Timeout { .. }), "{err:?}");

        let pid = fs::read_to_string(&pid_file).unwrap().trim().to_string();
        // `kill -0` succeeds while the process is there; give the signal a
        // moment to land.
        let gone = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            !Command::new("kill")
                .args(["-0", &pid])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        });
        assert!(gone, "the grandchild sleep {pid} outlived the kill");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_grandchild_holding_stderr_does_not_hold_the_answer() {
        // The subshell keeps only the INHERITED stderr (stdout goes away);
        // sh itself exits at once. The old drain joined stderr's EOF, which
        // came thirty seconds later.
        let started = Instant::now();
        let out = sh("(sleep 30 >/dev/null) & echo out", None, GIT_TIMEOUT).unwrap();
        assert_eq!(out.text, "out\n");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the answer waited for the grandchild: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn output_past_the_cap_is_cut_at_a_line_and_the_child_stopped() {
        let started = Instant::now();
        // `yes` writes forever; the cap ends it.
        let out = sh("yes", Some(1000), GIT_TIMEOUT).unwrap();
        assert!(out.truncated);
        assert!(out.text.len() <= 1000);
        assert!(out.text.ends_with('\n'), "cut at a line break");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_failure_keeps_a_bounded_head_of_stderr() {
        let script = format!(
            "head -c {} /dev/zero | tr '\\0' x 1>&2; exit 3",
            STDERR_MAX_BYTES * 4
        );
        let err = sh(&script, None, GIT_TIMEOUT).unwrap_err();
        let GitError::Command { status, stderr, .. } = err else {
            panic!("expected a command failure, got {err:?}");
        };
        assert_eq!(status, Some(3));
        assert!(stderr.ends_with(" …"), "cut with a mark: {}", &stderr[stderr.len() - 8..]);
        assert!(stderr.len() <= STDERR_MAX_BYTES + 4);
    }

    #[test]
    fn a_child_that_fails_on_its_own_past_the_cap_is_still_a_failure() {
        // Everything is written at once and the child exits 7 by itself —
        // its exit, not a cut, so it must not be forgiven as one.
        let err = sh(
            "head -c 5000 /dev/zero | tr '\\0' y; exit 7",
            Some(1000),
            GIT_TIMEOUT,
        )
        .unwrap_err();
        assert!(
            matches!(err, GitError::Command { status: Some(7), .. }),
            "{err:?}"
        );
    }

    #[test]
    fn a_child_with_nothing_more_to_say_after_the_cap_is_stopped_not_awaited() {
        // Past the cap, the child writes nothing more (so no broken pipe
        // ends it) and would sit for thirty seconds; the grace ends it.
        let started = Instant::now();
        let out = sh("yes | head -c 5000; sleep 30", Some(1000), GIT_TIMEOUT).unwrap();
        assert!(out.truncated);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "waited for the child: {:?}",
            started.elapsed()
        );
    }
}
