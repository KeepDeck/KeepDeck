use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::GitError;

/// Every git process this crate has spawned in this process, counted at the
/// one boundary that spawns them.
static SPAWNS: AtomicU64 = AtomicU64::new(0);

/// How many git processes the crate has spawned so far — a monotonic count,
/// so a caller measures a read's cost as a difference. The unit that matters
/// for a read that fans out per worktree is processes, not seconds: seconds
/// vary with the machine, the count is the design.
pub fn spawns() -> u64 {
    SPAWNS.load(Ordering::Relaxed)
}

/// Output read under a byte cap: the text up to the cap, cut at the last
/// line break within it so no line arrives half, and whether anything was
/// left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capped {
    pub text: String,
    pub truncated: bool,
}

/// Run `git -C <dir> <args...>` and return its stdout up to `max_bytes`.
///
/// The counterpart of [`run_git`] for commands whose output has no natural
/// bound — a diff of a generated file can run to hundreds of megabytes, and
/// `.output()` would hold every byte before anyone could decide it was too
/// much. Stdout is read as a stream and the child is killed once the cap is
/// passed; stderr drains on its own thread so a chatty child can never
/// block the read. Below the cap this behaves exactly like [`run_git`]: a
/// non-zero exit is [`GitError::Command`] with the args and stderr.
pub(crate) fn run_git_capped<I, S>(dir: &Path, args: I, max_bytes: usize) -> Result<Capped, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<S> = args.into_iter().collect();
    SPAWNS.fetch_add(1, Ordering::Relaxed);
    let mut child = Command::new("git")
        .env("PATH", keepdeck_env::augmented_path())
        .arg("-C")
        .arg(dir)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(GitError::Spawn)?;

    let mut stderr = child.stderr.take().expect("stderr was piped");
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut buf = Vec::with_capacity(max_bytes.min(64 * 1024));
    // One byte past the cap tells "exactly at the cap" from "more to come".
    let read = (&mut stdout)
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(GitError::Spawn);
    let truncated = buf.len() > max_bytes;
    if truncated {
        // The rest is not wanted: stop the child instead of draining it.
        let _ = child.kill();
    }
    drop(stdout);
    let status = child.wait().map_err(GitError::Spawn)?;
    let stderr_bytes = stderr_reader.join().unwrap_or_default();
    read?;

    if !truncated && !status.success() {
        return Err(GitError::Command {
            args: args
                .iter()
                .map(|a| a.as_ref().to_string_lossy().into_owned())
                .collect(),
            status: status.code(),
            stderr: String::from_utf8_lossy(&stderr_bytes).trim().to_string(),
        });
    }

    if truncated {
        // Whole lines only: cut at the last line break inside the cap, so the
        // reader never sees a line that stops mid-way. A single line longer
        // than the cap is kept as it is — there is no better place to cut.
        buf.truncate(max_bytes);
        if let Some(nl) = buf.iter().rposition(|b| *b == b'\n') {
            buf.truncate(nl + 1);
        }
    }
    Ok(Capped {
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
    })
}

/// Run `git -C <dir> <args...>` and return its stdout on success.
///
/// This is the single boundary where the crate shells out to the user's `git`;
/// everything else is pure logic over the strings it returns. Args are
/// `AsRef<OsStr>` so callers can pass paths losslessly — a `to_string_lossy`
/// would corrupt a non-UTF-8 path (real on Linux). A non-zero exit becomes
/// [`GitError::Command`] carrying the args and stderr.
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
    let args: Vec<S> = args.into_iter().collect();
    SPAWNS.fetch_add(1, Ordering::Relaxed);
    let output = Command::new("git")
        .env("PATH", keepdeck_env::augmented_path())
        .arg("-C")
        .arg(dir)
        .args(&args)
        .output()
        .map_err(GitError::Spawn)?;

    if !output.status.success() {
        return Err(GitError::Command {
            // Display-only; the actual args passed to git were lossless OsStrs.
            args: args
                .iter()
                .map(|a| a.as_ref().to_string_lossy().into_owned())
                .collect(),
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
