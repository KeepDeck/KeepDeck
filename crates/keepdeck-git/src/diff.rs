use std::ffi::OsStr;
use std::path::Path;

use crate::cmd::{run_git, run_git_capped, Capped};
use crate::error::GitError;

/// How much of one file's diff crosses into the webview. A diff of a
/// generated file can run to hundreds of megabytes; the reader needs its
/// head and a word that it was cut, not the whole of it. The same order as
/// the host's default file-read cap.
pub const DIFF_MAX_BYTES: usize = 1024 * 1024;

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
///
/// `orig` is the file's path before a rename (the status entry's old path).
/// Git can only pair a rename when BOTH paths are in the pathspec: limited to
/// the new one, it reports the file as added in full. See [`rename_pathspec`].
pub fn diff_file(
    repo: &Path,
    file: &str,
    staged: bool,
    orig: Option<&str>,
) -> Result<Capped, GitError> {
    let mut args: Vec<&OsStr> = vec![
        OsStr::new("--no-optional-locks"),
        OsStr::new("diff"),
        OsStr::new("--no-color"),
        OsStr::new("--no-ext-diff"),
    ];
    if staged {
        args.push(OsStr::new("--cached"));
    }
    if orig.is_some() {
        args.push(OsStr::new("-M"));
    }
    pathspec(&mut args, file, orig);
    run_git_capped(repo, args, DIFF_MAX_BYTES)
}

/// Append `--` and the pathspec: the file, preceded by its old path when the
/// caller knows one. Git pairs a rename only when both names are in the
/// pathspec (the caller turns `-M` on beside this); limited to the new one it
/// reports the file as added in full. `--` ends option parsing — the paths
/// come from git's own status output, but the guard matches the crate's
/// other path-taking commands.
fn pathspec<'a>(args: &mut Vec<&'a OsStr>, file: &'a str, orig: Option<&'a str>) {
    args.push(OsStr::new("--"));
    if let Some(orig) = orig {
        args.push(OsStr::new(orig));
    }
    args.push(OsStr::new(file));
}

/// Unified diff for one path across a REVISION range: `from..to`, or `from`
/// against the working tree when `to` is `None` (the "everything since the
/// fork, committed or not" view). Same flags and guards as [`diff_file`].
///
/// `--end-of-options` sits between the flags and the revisions: git reads
/// options up to `--`, so a revision spelled `--output=<path>` would otherwise
/// be obeyed — and write the diff to any path, outside every containment the
/// caller checked. Behind the guard such a spelling is a bad revision.
pub fn diff_file_range(
    repo: &Path,
    file: &str,
    from: &str,
    to: Option<&str>,
    orig: Option<&str>,
) -> Result<Capped, GitError> {
    let mut args: Vec<&OsStr> = vec![
        OsStr::new("--no-optional-locks"),
        OsStr::new("diff"),
        OsStr::new("--no-color"),
        OsStr::new("--no-ext-diff"),
    ];
    // `-M` is an option, so it must precede `--end-of-options`.
    if orig.is_some() {
        args.push(OsStr::new("-M"));
    }
    args.push(OsStr::new("--end-of-options"));
    args.push(OsStr::new(from));
    if let Some(to) = to {
        args.push(OsStr::new(to));
    }
    pathspec(&mut args, file, orig);
    run_git_capped(repo, args, DIFF_MAX_BYTES)
}

/// One changed path from a revision-range diff (`--name-status`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    /// Path relative to the repository root (the NEW side for renames/copies).
    pub path: String,
    /// The old path, for renames and copies.
    pub orig_path: Option<String>,
    /// The status letter: `M`/`A`/`D`/`R`/`C`/`T` (similarity scores dropped),
    /// or `?` for an untracked file in a working-tree range.
    pub code: char,
}

/// The paths changed across a revision range — `from..to`, or `from` against
/// the working tree when `to` is `None`. `-M` detects renames so a moved file
/// is one entry with both names, matching what status shows for staged moves.
/// `--end-of-options` guards the revisions the way [`diff_file_range`] does.
///
/// The working-tree form means "everything since `from`, committed or not",
/// and untracked files are part of that work: `git diff` never lists them
/// (it only knows tracked paths), so they are appended from `ls-files`, each
/// as an entry with code `?` — the status letter for untracked. Ignored files
/// stay out, as they do in status.
pub fn changed_files(
    repo: &Path,
    from: &str,
    to: Option<&str>,
) -> Result<Vec<ChangedFile>, GitError> {
    let mut files = changed_tracked_files(repo, from, to)?;
    if to.is_none() {
        files.extend(untracked_files(repo)?);
    }
    Ok(files)
}

/// The paths git itself reports across the range: tracked files only.
fn changed_tracked_files(
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
        OsStr::new("--end-of-options"),
        OsStr::new(from),
    ];
    if let Some(to) = to {
        args.push(OsStr::new(to));
    }
    args.push(OsStr::new("--"));
    let out = run_git(repo, args)?;
    Ok(parse_name_status(&out))
}

/// Untracked, not ignored files of the working tree — each its own entry
/// (`ls-files --others` lists files, never directories), as `?` entries.
fn untracked_files(repo: &Path) -> Result<Vec<ChangedFile>, GitError> {
    let out = run_git(
        repo,
        [
            "--no-optional-locks",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    Ok(out
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| ChangedFile {
            path: path.to_string(),
            orig_path: None,
            code: '?',
        })
        .collect())
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
