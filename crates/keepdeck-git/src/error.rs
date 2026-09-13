use std::fmt;
use std::time::Duration;

/// An error from a git operation.
///
/// The `Display` of a failed or timed-out command is one frame — `` `git
/// <args>` failed (<why>): <detail> `` — that the host relays verbatim and
/// the plugin reads the repository's state out of; keep the frame when the
/// variants change.
#[derive(Debug)]
pub enum GitError {
    /// A caller supplied metadata that violates a public API contract.
    InvalidInput(String),
    /// The `git` binary could not be launched (not installed / not on `PATH`).
    Spawn(std::io::Error),
    /// A git command ran but exited non-zero; carries the args and its stderr.
    Command {
        /// The arguments passed after `git -C <dir>`.
        args: Vec<String>,
        /// Exit code, when the process wasn't terminated by a signal.
        status: Option<i32>,
        /// Trimmed stderr from the failed command, cut at
        /// [`crate::cmd::STDERR_MAX_BYTES`] with a mark.
        stderr: String,
    },
    /// A git command gave no answer within the crate's timeout and was
    /// killed, with its process group.
    Timeout {
        /// The arguments passed after `git -C <dir>`.
        args: Vec<String>,
        /// How long it had been running.
        after: Duration,
    },
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GitError::InvalidInput(message) => write!(f, "invalid git input: {message}"),
            GitError::Spawn(e) => write!(f, "failed to run git: {e}"),
            GitError::Command {
                args,
                status,
                stderr,
            } => {
                let code = status
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".to_string());
                write!(f, "`git {}` failed (exit {code}): {stderr}", args.join(" "))
            }
            GitError::Timeout { args, after } => write!(
                f,
                "`git {}` failed (timeout): gave no answer in {}s",
                args.join(" "),
                after.as_secs()
            ),
        }
    }
}

impl std::error::Error for GitError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            GitError::Spawn(e) => Some(e),
            _ => None,
        }
    }
}
