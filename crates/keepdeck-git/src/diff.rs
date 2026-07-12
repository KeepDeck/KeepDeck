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

/// Unified diff for one path across a REVISION range: `from..to`, or `from`
/// against the working tree when `to` is `None` (the "everything since the
/// fork, committed or not" view). Same flags and guards as [`diff_file`].
pub fn diff_file_range(
    repo: &Path,
    file: &str,
    from: &str,
    to: Option<&str>,
) -> Result<String, GitError> {
    let mut args: Vec<&OsStr> = vec![
        OsStr::new("--no-optional-locks"),
        OsStr::new("diff"),
        OsStr::new("--no-color"),
        OsStr::new("--no-ext-diff"),
        OsStr::new(from),
    ];
    if let Some(to) = to {
        args.push(OsStr::new(to));
    }
    args.push(OsStr::new("--"));
    args.push(OsStr::new(file));
    run_git(repo, args)
}

/// One changed path from a revision-range diff (`--name-status`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    /// Path relative to the repository root (the NEW side for renames/copies).
    pub path: String,
    /// The old path, for renames and copies.
    pub orig_path: Option<String>,
    /// The status letter: `M`/`A`/`D`/`R`/`C`/`T` (similarity scores dropped).
    pub code: char,
}

/// The paths changed across a revision range — `from..to`, or `from` against
/// the working tree when `to` is `None`. `-M` detects renames so a moved file
/// is one entry with both names, matching what status shows for staged moves.
pub fn changed_files(
    repo: &Path,
    from: &str,
    to: Option<&str>,
) -> Result<Vec<ChangedFile>, GitError> {
    let mut args: Vec<&OsStr> = vec![
        OsStr::new("--no-optional-locks"),
        OsStr::new("diff"),
        OsStr::new("--name-status"),
        OsStr::new("-M"),
        OsStr::new("-z"),
        OsStr::new(from),
    ];
    if let Some(to) = to {
        args.push(OsStr::new(to));
    }
    args.push(OsStr::new("--"));
    let out = run_git(repo, args)?;
    Ok(parse_name_status(&out))
}

/// Parse `diff --name-status -z` output. Pure: tokens alternate
/// `status, path[, path2]` — renames/copies (`R###`/`C###`) carry the OLD path
/// first, then the new one.
pub fn parse_name_status(out: &str) -> Vec<ChangedFile> {
    let mut files = Vec::new();
    let mut tokens = out.split('\0');
    while let Some(status) = tokens.next() {
        if status.is_empty() {
            continue;
        }
        let Some(code) = status.chars().next() else {
            continue;
        };
        let Some(first) = tokens.next() else { break };
        if code == 'R' || code == 'C' {
            let Some(second) = tokens.next() else { break };
            files.push(ChangedFile {
                path: second.to_string(),
                orig_path: Some(first.to_string()),
                code,
            });
        } else {
            files.push(ChangedFile {
                path: first.to_string(),
                orig_path: None,
                code,
            });
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status_with_renames() {
        let out = "M\0src/app.ts\0R100\0old name.ts\0new name.ts\0A\0added.md\0";
        let files = parse_name_status(out);
        assert_eq!(files.len(), 3);

        assert_eq!(files[0].code, 'M');
        assert_eq!(files[0].path, "src/app.ts");
        assert_eq!(files[0].orig_path, None);

        assert_eq!(files[1].code, 'R');
        assert_eq!(files[1].path, "new name.ts");
        assert_eq!(files[1].orig_path.as_deref(), Some("old name.ts"));

        assert_eq!(files[2].code, 'A');
    }

    #[test]
    fn empty_output_is_no_files() {
        assert!(parse_name_status("").is_empty());
    }
}
