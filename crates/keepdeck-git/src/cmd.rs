use std::path::Path;
use std::process::Command;

use crate::error::GitError;

/// Run `git -C <dir> <args...>` and return its stdout on success.
///
/// This is the single boundary where the crate shells out to the user's `git`;
/// everything else is pure logic over the strings it returns. A non-zero exit
/// becomes [`GitError::Command`] carrying the args and stderr.
pub(crate) fn run_git(dir: &Path, args: &[&str]) -> Result<String, GitError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(GitError::Spawn)?;

    if !output.status.success() {
        return Err(GitError::Command {
            args: args.iter().map(|s| s.to_string()).collect(),
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
