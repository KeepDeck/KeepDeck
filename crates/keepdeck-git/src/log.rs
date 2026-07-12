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

/// Field/record separators for the log format: ASCII unit/record separators,
/// which can't appear in a sha, an author name from git config, or a subject
/// (git strips control characters from subjects on commit).
const FIELD_SEP: char = '\u{1f}';
const RECORD_SEP: char = '\u{1e}';

/// List commits, newest first. `range` is a git revision range (e.g.
/// `abc..HEAD`) — `None` walks from `HEAD`. `limit` caps the walk either way,
/// so a log over an unexpectedly deep range never floods the caller.
///
/// `--no-optional-locks` for the same reason as status: a history poller must
/// never take a lock an agent's own git commands could trip over.
pub fn log(repo: &Path, range: Option<&str>, limit: usize) -> Result<Vec<Commit>, GitError> {
    let format = format!("--format=%H{FIELD_SEP}%an{FIELD_SEP}%at{FIELD_SEP}%s{RECORD_SEP}");
    let limit = format!("-n{limit}");
    let mut args = vec![
        "--no-optional-locks",
        "log",
        format.as_str(),
        limit.as_str(),
    ];
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

/// Parse the custom-format log output. Pure; tolerant of blank records (the
/// trailing separator produces one).
pub fn parse_log(out: &str) -> Vec<Commit> {
    out.split(RECORD_SEP)
        .filter_map(|record| {
            let record = record.trim_start_matches(['\n', '\r']);
            if record.is_empty() {
                return None;
            }
            let mut fields = record.splitn(4, FIELD_SEP);
            let sha = fields.next()?.trim();
            let author = fields.next()?;
            let timestamp = fields.next()?.parse::<i64>().ok()?;
            let subject = fields.next()?;
            if sha.is_empty() {
                return None;
            }
            Some(Commit {
                sha: sha.to_string(),
                author: author.to_string(),
                timestamp,
                subject: subject.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(sha: &str, author: &str, ts: &str, subject: &str) -> String {
        format!("{sha}{FIELD_SEP}{author}{FIELD_SEP}{ts}{FIELD_SEP}{subject}{RECORD_SEP}\n")
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
    fn keeps_field_separator_lookalikes_in_subjects() {
        // Colons, dashes, unicode — a subject is arbitrary text short of
        // control chars; only the real \x1f splits fields.
        let out = record("ccc333", "Carol", "1", "feat: a — b :: c");
        assert_eq!(parse_log(&out)[0].subject, "feat: a — b :: c");
    }

    #[test]
    fn skips_malformed_and_empty_records() {
        let out = format!("{RECORD_SEP}\n\nnot-a-record{RECORD_SEP}");
        assert!(parse_log(&out).is_empty());
        assert!(parse_log("").is_empty());
    }
}
