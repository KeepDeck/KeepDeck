//! One file's content as git stores it — at a revision, or in the index.
//!
//! The other half of a diff: a unified diff carries only its hunks, and a
//! reader that wants the lines between them (a highlighter's grammar state,
//! say) needs the whole file on each side. The working tree's side is a plain
//! file read; these are the sides only git can produce.

use std::path::Path;

use crate::cmd::{run_git, run_git_capped, Capped};
use crate::error::GitError;

/// How much of one stored file crosses into the webview — the diff's cap, for
/// the same reason (a generated file can be hundreds of megabytes).
pub const BLOB_MAX_BYTES: usize = 1024 * 1024;

/// `path`'s content at `rev`, or in the index when `rev` is `None`, capped at
/// [`BLOB_MAX_BYTES`] (whole lines). `Ok(None)` when there is no such file
/// there — added after `rev`, deleted from the index, a revision that names
/// no commit. Every other failure is an error, not an absence.
///
/// The bytes are the stored blob: `cat-file` applies no textconv, no smudge
/// filter and no end-of-line conversion — the same normalized content a
/// `git diff` of that side shows.
pub fn file_at(repo: &Path, path: &str, rev: Option<&str>) -> Result<Option<Capped>, GitError> {
    let spec = match rev {
        // `rev-parse` takes options up to the first non-option, and a
        // revision spelled `--output=…` must never be read as one.
        Some(rev) if rev.starts_with('-') => {
            return Err(GitError::InvalidInput(format!("not a revision: {rev}")))
        }
        Some(rev) => format!("{rev}:{path}"),
        None => format!(":{path}"),
    };
    let Some(oid) = resolve_blob(repo, &spec)? else {
        return Ok(None);
    };
    run_git_capped(
        repo,
        ["--no-optional-locks", "cat-file", "blob", oid.as_str()],
        BLOB_MAX_BYTES,
    )
    .map(Some)
}

/// The object id `spec` names, or `None` when it names nothing. `--quiet`
/// makes a miss a silent exit 1, which is the one failure that means
/// "absent"; anything git says on stderr is a real error.
fn resolve_blob(repo: &Path, spec: &str) -> Result<Option<String>, GitError> {
    match run_git(
        repo,
        [
            "--no-optional-locks",
            "rev-parse",
            "--verify",
            "--quiet",
            spec,
        ],
    ) {
        Ok(out) => Ok(Some(out.trim().to_string())),
        Err(GitError::Command {
            status: Some(1),
            stderr,
            ..
        }) if stderr.is_empty() => Ok(None),
        Err(e) => Err(e),
    }
}
