use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;

use crate::error::GitError;

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
