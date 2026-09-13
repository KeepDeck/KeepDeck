use std::path::Path;

use crate::cmd::run_git;
use crate::error::GitError;

/// One commit from `git log`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    /// Full commit sha.
    pub sha: String,
    /// Author name.
    pub author: String,
    /// Author time, unix seconds.
    pub timestamp: i64,
    /// The one-line subject.
    pub subject: String,
}

/// The one byte that can be in none of the fields: a sha is hex, a timestamp
/// digits, and git itself stores names and subjects as C strings — a NUL
/// ends them. Anything else can turn up in an author's name: git strips
/// control characters from a SUBJECT on commit, not from `user.name`, and
/// the unit and record separators this format used to rely on shifted the
/// fields of any commit whose author carried one, dropping the commit from
/// the list without a word.
const SEP: char = '\0';

/// Fields per commit in the log format: sha, author, time, subject.
const FIELDS: usize = 4;

/// List commits, newest first. `range` is a git revision range (e.g.
/// `abc..HEAD`) — `None` walks from `HEAD`. `limit` caps the walk either way,
/// so a log over an unexpectedly deep range never floods the caller.
///
/// `--no-optional-locks` for the same reason as status: a history poller must
/// never take a lock an agent's own git commands could trip over. `-z` ends
/// each commit with a NUL like the fields, so the output is one flat
/// NUL-separated sequence read four at a time (`parse_log`).
pub fn log(repo: &Path, range: Option<&str>, limit: usize) -> Result<Vec<Commit>, GitError> {
    // `%x00` is git's spelling of the byte: an argument cannot carry a NUL.
    let format = "--format=%H%x00%an%x00%at%x00%s";
    let limit = format!("-n{limit}");
    let mut args = vec!["--no-optional-locks", "log", "-z", format, limit.as_str()];
    if let Some(range) = range {
        args.push(range);
    }
    let out = run_git(repo, args)?;
    Ok(parse_log(&out))
}

/// How many commits a revision range spans — `git rev-list --count`. Cheap
/// (no diffs, no messages), so a UI can show an honest "N commits since the
/// fork" even when the fork sits beyond whatever the log listing was capped
/// at.
pub fn count_range(repo: &Path, range: &str) -> Result<u32, GitError> {
    let out = run_git(repo, ["--no-optional-locks", "rev-list", "--count", range])?;
    out.trim().parse::<u32>().map_err(|_| GitError::Command {
        args: vec!["rev-list".into(), "--count".into(), range.into()],
        status: None,
        stderr: format!("unparseable count: {out:?}"),
    })
}

/// Parse the log output: one flat NUL-separated sequence, four fields per
/// commit. Pure. A trailing NUL (git's `-z` terminator) leaves an empty
/// last token, dropped; a short tail — output cut mid-commit — is dropped
/// too rather than read as a commit with fields in the wrong places.
pub fn parse_log(out: &str) -> Vec<Commit> {
    let mut tokens: Vec<&str> = out.split(SEP).collect();
    if tokens.last().is_some_and(|last| last.is_empty()) {
        tokens.pop();
    }
    tokens
        .chunks_exact(FIELDS)
        .filter_map(|fields| {
            let sha = fields[0].trim();
            if sha.is_empty() {
                return None;
            }
            Some(Commit {
                sha: sha.to_string(),
                author: fields[1].to_string(),
                timestamp: fields[2].parse::<i64>().ok()?,
                subject: fields[3].to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(sha: &str, author: &str, ts: &str, subject: &str) -> String {
        format!("{sha}{SEP}{author}{SEP}{ts}{SEP}{subject}{SEP}")
    }

    #[test]
    fn parses_records_newest_first() {
        let out = format!(
            "{}{}",
            record("aaa111", "Alice", "1760000000", "Fix the thing"),
            record("bbb222", "Bob", "1750000000", "Start the thing"),
        );
        let commits = parse_log(&out);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].sha, "aaa111");
        assert_eq!(commits[0].author, "Alice");
        assert_eq!(commits[0].timestamp, 1_760_000_000);
        assert_eq!(commits[0].subject, "Fix the thing");
        assert_eq!(commits[1].sha, "bbb222");
    }

    #[test]
    fn control_characters_in_an_author_or_subject_stay_text() {
        // The old unit/record separators, in a name — a commit whose fields
        // shifted and which fell out of the list.
        let out = record("ccc333", "Ca\u{1f}rol\u{1e}", "1", "feat: a — b :: c\u{1f}d");
        let commits = parse_log(&out);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].author, "Ca\u{1f}rol\u{1e}");
        assert_eq!(commits[0].subject, "feat: a — b :: c\u{1f}d");
    }

    #[test]
    fn an_empty_subject_is_a_field_like_any_other() {
        let out = record("ddd444", "Dan", "2", "");
        let commits = parse_log(&out);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "");
    }

    #[test]
    fn skips_a_short_tail_and_empty_output() {
        // Cut mid-commit: three fields at the end must not become a commit.
        let out = format!("{}eee555{SEP}Eve{SEP}3", record("aaa111", "Alice", "1", "ok"));
        let commits = parse_log(&out);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].sha, "aaa111");
        assert!(parse_log("").is_empty());
        assert!(parse_log("\0").is_empty());
    }
}
