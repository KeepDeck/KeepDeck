//! Which branches were CREATED in a given worktree — reflog provenance.
//!
//! Git stores no branch→worktree link: branches are repo-wide refs, and
//! `git worktree remove` neither knows nor cares what was born where. But the
//! link is recoverable from two reflogs git already writes:
//!
//! - each worktree has a PRIVATE `HEAD` reflog (its birth entry plus every
//!   `checkout: moving from A to B` made inside it), and
//! - each branch's own reflog opens with a `branch: Created from …` entry
//!   stamped at creation time.
//!
//! A branch was created in worktree W exactly when its creation stamp lines up
//! with W's HEAD log: same timestamp AND same branch name as a checkout target
//! (`git switch -c`), or — for the branch W was born on — the same timestamp as
//! W's birth entry (`git worktree add -b`, which writes no checkout line).
//! Matching pairs timestamp WITH name, never timestamp alone: two worktrees
//! acting in the same second is real, and a bare timestamp match would claim a
//! neighbour's branch.
//!
//! Known limit: `git branch X` inside W (created, never checked out) leaves no
//! trace in W's HEAD log and is indistinguishable from the same command run in
//! any other worktree — such a branch is deliberately NOT attributed, erring on
//! the side of keeping it. Expired or disabled reflogs also attribute nothing:
//! no evidence, no claim.

use std::path::Path;

use crate::cmd::run_git;
use crate::error::GitError;
use crate::repo;

/// One reflog entry: its unix timestamp and message ("" for a worktree's
/// birth entry, which git writes without one).
struct ReflogEntry {
    ts: u64,
    message: String,
}

/// `%gd` = the date-based selector (`ref@{<unix>}` under `--date=unix`),
/// `%x09` = a literal tab, `%gs` = the entry's message.
const REFLOG_FORMAT: &str = "--format=%gd%x09%gs";

/// Parse `log -g` output in [`REFLOG_FORMAT`] order (newest first, as git
/// prints it). Lines that don't carry a parsable `@{<unix>}` selector are
/// skipped — bad evidence attributes nothing.
fn parse_reflog(out: &str) -> Vec<ReflogEntry> {
    out.lines()
        .filter_map(|line| {
            let (selector, message) = match line.split_once('\t') {
                Some((s, m)) => (s, m),
                None => (line, ""),
            };
            let ts = selector
                .rfind("@{")
                .and_then(|i| selector[i + 2..].strip_suffix('}'))
                .and_then(|ts| ts.parse::<u64>().ok())?;
            Some(ReflogEntry {
                ts,
                message: message.to_string(),
            })
        })
        .collect()
}

/// Split a `checkout: moving from A to B` message into `(A, B)`. Branch names
/// cannot contain spaces (`git check-ref-format` forbids them), so the first
/// ` to ` is unambiguously the separator.
fn checkout_move(message: &str) -> Option<(&str, &str)> {
    message
        .strip_prefix("checkout: moving from ")?
        .split_once(" to ")
}

/// The branch a worktree was born on: the SOURCE of its oldest checkout entry.
/// A worktree that never switched has no checkout lines — then the currently
/// checked-out branch (`fallback`) IS the initial one. `None` for a worktree
/// born detached.
fn initial_branch<'a>(entries: &'a [ReflogEntry], fallback: Option<&'a str>) -> Option<&'a str> {
    entries
        .iter()
        .rev()
        .find_map(|e| checkout_move(&e.message).map(|(from, _)| from))
        .or(fallback)
}

/// The provenance verdict for one branch: does its creation stamp pair up with
/// this worktree's HEAD log (birth entry for the initial branch, else a
/// same-second checkout TO that branch)?
fn is_created_here(
    entries: &[ReflogEntry],
    initial: Option<&str>,
    branch: &str,
    creation_ts: u64,
) -> bool {
    let born_with_worktree =
        initial == Some(branch) && entries.last().is_some_and(|birth| birth.ts == creation_ts);
    born_with_worktree
        || entries.iter().any(|e| {
            e.ts == creation_ts && checkout_move(&e.message).is_some_and(|(_, to)| to == branch)
        })
}

/// The unix timestamp a branch was created at — its reflog's oldest entry,
/// counted only when that entry really is the creation record (an expired
/// reflog whose tail was cut is no evidence). `None` when the reflog is gone
/// entirely; both collapse to "cannot attribute", an answer, not an error.
fn creation_ts(repo_path: &Path, branch: &str) -> Result<Option<u64>, GitError> {
    match run_git(
        repo_path,
        [
            "--no-optional-locks",
            "log",
            "-g",
            "--date=unix",
            REFLOG_FORMAT,
            branch,
            "--",
        ],
    ) {
        Ok(out) => Ok(parse_reflog(&out)
            .last()
            .filter(|e| e.message.starts_with("branch: Created from"))
            .map(|e| e.ts)),
        // No reflog for the ref is an answer, not an error.
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The local branches that were CREATED in the worktree at `worktree`, in
/// branch-list (refname) order.
///
/// Must run while the worktree still EXISTS: the evidence is its private HEAD
/// reflog, which `git worktree remove` destroys with the administrative dir —
/// callers enumerate first, remove second, delete branches last.
pub fn created_branches(repo_path: &Path, worktree: &Path) -> Result<Vec<String>, GitError> {
    let head_log = match run_git(
        worktree,
        [
            "--no-optional-locks",
            "log",
            "-g",
            "--date=unix",
            REFLOG_FORMAT,
            "HEAD",
            "--",
        ],
    ) {
        Ok(out) => parse_reflog(&out),
        // A worktree without a HEAD reflog (core.logAllRefUpdates off) has no
        // provenance to read — nothing can be attributed.
        Err(GitError::Command { .. }) => return Ok(Vec::new()),
        Err(other) => return Err(other),
    };
    if head_log.is_empty() {
        return Ok(Vec::new());
    }

    let current = repo::current_branch(worktree)?;
    let initial = initial_branch(&head_log, current.as_deref());

    let mut created = Vec::new();
    for branch in repo::list_branches(repo_path)? {
        let Some(ts) = creation_ts(repo_path, &branch)? else {
            continue;
        };
        if is_created_here(&head_log, initial, &branch, ts) {
            created.push(branch);
        }
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts: u64, message: &str) -> ReflogEntry {
        ReflogEntry {
            ts,
            message: message.to_string(),
        }
    }

    /// A typical worktree HEAD log, newest first: born at 100 on `born`,
    /// switched to a fresh `inside` at 200, then to `other` at 300.
    fn head_log() -> Vec<ReflogEntry> {
        vec![
            entry(300, "checkout: moving from inside to other"),
            entry(200, "checkout: moving from born to inside"),
            entry(100, ""),
        ]
    }

    #[test]
    fn parses_selectors_messages_and_the_bare_birth_line() {
        let parsed = parse_reflog(
            "HEAD@{300}\tcheckout: moving from a to b\nHEAD@{100}\t\nHEAD@{50}\nnot a reflog line\n",
        );
        // The tab-less birth variant and the trailing-tab variant both parse;
        // the garbage line is dropped.
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].ts, 300);
        assert_eq!(parsed[0].message, "checkout: moving from a to b");
        assert_eq!(parsed[1].ts, 100);
        assert_eq!(parsed[1].message, "");
        assert_eq!(parsed[2].ts, 50);
    }

    #[test]
    fn initial_branch_is_the_oldest_checkout_source_else_the_fallback() {
        assert_eq!(initial_branch(&head_log(), Some("current")), Some("born"));
        // Never switched: the current branch is the one it was born on.
        let unswitched = vec![entry(100, "")];
        assert_eq!(initial_branch(&unswitched, Some("current")), Some("current"));
        assert_eq!(initial_branch(&unswitched, None), None);
    }

    #[test]
    fn the_birth_branch_matches_only_with_the_birth_timestamp() {
        let log = head_log();
        assert!(is_created_here(&log, Some("born"), "born", 100));
        // Same name, wrong second — an attached pre-existing branch.
        assert!(!is_created_here(&log, Some("born"), "born", 99));
        // Same second, different branch — the neighbour-worktree collision.
        assert!(!is_created_here(&log, Some("born"), "elsewhere", 100));
    }

    #[test]
    fn a_checkout_target_matches_only_as_a_timestamp_name_pair() {
        let log = head_log();
        assert!(is_created_here(&log, Some("born"), "inside", 200));
        // `git branch` in the same second as a switch: name pairing rejects it.
        assert!(!is_created_here(&log, Some("born"), "no-checkout", 200));
        // Switched TO at 300, but created earlier elsewhere.
        assert!(!is_created_here(&log, Some("born"), "other", 250));
    }
}
