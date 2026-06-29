use std::fmt;

/// An error from a git operation.
#[derive(Debug)]
pub enum GitError {
    /// The `git` binary could not be launched (not installed / not on `PATH`).
    Spawn(std::io::Error),
    /// A git command ran but exited non-zero; carries the args and its stderr.
    Command {
        /// The arguments passed after `git -C <dir>`.
        args: Vec<String>,
        /// Exit code, when the process wasn't terminated by a signal.
        status: Option<i32>,
        /// Trimmed stderr from the failed command.
        stderr: String,
    },
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
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
