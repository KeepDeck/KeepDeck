use std::ffi::OsStr;
use std::path::Path;

use crate::cmd::run_git;
use crate::error::GitError;

/// Unified diff for one tracked path — worktree vs index by default, index vs
/// HEAD with `staged`. Returns git's raw diff text; hunk parsing is the
/// consumer's concern (it stays presentation logic, not git logic).
///
/// Untracked files are NOT diffable here: `git diff --no-index` exits non-zero
/// on any difference, which [`run_git`] rightly treats as failure — callers
/// render an untracked file from its plain content instead.
///
/// `--no-optional-locks` keeps this a pure read (see [`crate::status::status`]);
/// `--no-ext-diff` pins output to git's own format — a user-configured external
/// diff driver could emit anything, or block.
pub fn diff_file(repo: &Path, file: &str, staged: bool) -> Result<String, GitError> {
    let mut args: Vec<&OsStr> = vec![
        OsStr::new("--no-optional-locks"),
        OsStr::new("diff"),
        OsStr::new("--no-color"),
        OsStr::new("--no-ext-diff"),
    ];
    if staged {
        args.push(OsStr::new("--cached"));
    }
    // `--` ends option parsing — the path comes from status output, but the
    // guard matches the crate's other path-taking commands.
    args.push(OsStr::new("--"));
    args.push(OsStr::new(file));
    run_git(repo, args)
}
