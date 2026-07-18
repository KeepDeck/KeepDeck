//! Which branches were CREATED in a given worktree — reflog provenance.
//!
//! Git stores no branch→worktree link: branches are repo-wide refs, and
//! `git worktree remove` neither knows nor cares what was born where. But the
//! link is recoverable from two reflogs git already writes:
//!
//! - each worktree has a PRIVATE `HEAD` reflog (its birth entry plus every
//!   `checkout: moving from A to B` made inside it), and
//! - each branch's own reflog opens with a `branch: Created from <source>`
//!   entry stamped at creation time.
//!
//! A branch is attributed to worktree W when its creation stamp lines up with
//! W's HEAD log — same timestamp AND same branch name as a checkout target
//! (`git switch -c`), or, for the branch W was born on, the same timestamp as
//! W's birth entry (`git worktree add -b`, which writes no checkout line) —
//! AND its creation SOURCE is one a single create-and-checkout operation
//! writes: `HEAD` (`switch -c`, `worktree add -b` off HEAD) or a full commit
//! sha (a pinned-base `worktree add -b <path> <sha>`, KeepDeck's own create).
//! `git branch X` and `switch -c X <name>` record the source branch NAME
//! instead; such creations are separate operations from any checkout, and
//! pairing them to a checkout by second is precisely the reproduced
//! false-claim (`git branch X && git worktree add wt X` inside one second) —
//! so name-sourced creations are never attributed.
//!
//! A checkout-target match additionally requires the entry's old and new
//! sides to AGREE: `switch -c` forks from the current HEAD and stays on that
//! commit, while a same-second VISIT of a branch born elsewhere moves to that
//! branch's own tip — so whenever the tips diverge, the visit is rejected on
//! shas even when its source reads trusted (`git branch Y HEAD && git switch
//! Y` with diverged histories).
//!
//! Deliberate misses (evidence errs toward KEEPING a branch):
//! - `git branch X` inside W — no checkout entry, name source: unattributable.
//! - `switch -c X <name-start>` / `git branch X && git switch X` inside W —
//!   name-sourced, rejected by the trust guard.
//! - `switch -c X <sha-start>` onto a commit other than the current HEAD —
//!   trusted source, but the old/new sides differ, so the sha check drops it.
//! - a created branch later RENAMED — the checkout entries still carry the old
//!   name, so the new name no longer pairs up.
//! - expired or disabled reflogs — no evidence, no claim.
//!
//! Residual false-claim: a standalone creation with a TRUSTED source —
//! `git branch Y HEAD` or `git branch Y <sha>`, which check nothing out —
//! followed within the same second by this worktree adopting Y while both
//! sit on the SAME commit: an attach (`git worktree add wt Y`, no checkout
//! entry to sha-check) or a switch with coinciding tips. Requires that exact
//! command shape inside one second; git's refusal to delete a held branch
//! protects it only while some other worktree still holds it at close time.
//!
//! The evidence survives the worktree DIRECTORY: after an external `rm -rf`,
//! the admin dir `.git/worktrees/<id>` keeps the HEAD reflog until
//! `git worktree prune`, and [`created_branches`] reads it from the main repo
//! through the `worktrees/<id>/HEAD` ref. After a prune the evidence is gone
//! and nothing is attributed.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::cmd::run_git;
use crate::error::GitError;
use crate::head::{self, Head};
use crate::repo;

/// One reflog entry: its unix timestamp, the commit its NEW side points to,
/// and its message ("" for a worktree's birth entry, which git writes without
/// one). The OLD side isn't printed by `log -g`, but within one log it is
/// simply the next-older entry's new side.
struct ReflogEntry {
    ts: u64,
    new_sha: String,
    message: String,
}

/// `%gd` = the date-based selector (`ref@{<unix>}` under `--date=unix`),
/// `%x09` = a literal tab, `%H` = the entry's new-side commit, `%gs` = the
/// entry's message.
const REFLOG_FORMAT: &str = "--format=%gd%x09%H%x09%gs";

/// Parse `log -g` output in [`REFLOG_FORMAT`] order (newest first, as git
/// prints it). Lines that don't carry a parsable `@{<unix>}` selector are
/// skipped — bad evidence attributes nothing.
fn parse_reflog(out: &str) -> Vec<ReflogEntry> {
    out.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let selector = parts.next()?;
            let new_sha = parts.next().unwrap_or("");
            let message = parts.next().unwrap_or("");
            let ts = selector
                .rfind("@{")
                .and_then(|i| selector[i + 2..].strip_suffix('}'))
                .and_then(|ts| ts.parse::<u64>().ok())?;
            Some(ReflogEntry {
                ts,
                new_sha: new_sha.to_string(),
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

/// Whether a creation entry's source is trusted evidence for same-second
/// pairing: `HEAD` or a full commit sha — what a single create-and-checkout
/// operation writes. A branch NAME as the source marks a standalone creation
/// (`git branch X`, `switch -c X <name>`), whose second proves nothing about
/// where it ran; see the module doc for the false-claim this rejects.
fn trusted_creation(message: &str) -> bool {
    message
        .strip_prefix("branch: Created from ")
        .is_some_and(|src| src == "HEAD" || head::is_commit_sha(src))
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
        || entries.iter().enumerate().any(|(i, e)| {
            e.ts == creation_ts
                && checkout_move(&e.message).is_some_and(|(_, to)| to == branch)
                // A switch that CREATED its target stays on the commit it left
                // (`switch -c` forks from the current HEAD), so the entry's old
                // and new sides agree; a same-second VISIT of a branch born
                // elsewhere moves to that branch's own tip. The old side is
                // the next-older entry's new side within this same log.
                && entries
                    .get(i + 1)
                    .is_some_and(|older| older.new_sha == e.new_sha)
        })
}

/// The unix timestamp a branch was created at — its reflog's oldest entry,
/// counted only when that entry is a creation record with a trusted source
/// ([`trusted_creation`]; an expired reflog whose tail was cut is no evidence
/// either). `None` when the reflog is gone entirely; every case collapses to
/// "cannot attribute" — an answer, not an error.
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
            .filter(|e| trusted_creation(&e.message))
            .map(|e| e.ts)),
        // No reflog for the ref is an answer, not an error.
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The worktree's HEAD reflog plus the fallback branch for [`initial_branch`],
/// or `None` when there is no evidence to read. Two routes to the same
/// private log: through the worktree directory while it exists, else through
/// the admin dir's `worktrees/<id>/HEAD` ref from the main repo — which is
/// how an externally-deleted worktree stays attributable until a prune.
fn head_evidence(
    repo_path: &Path,
    worktree: &Path,
) -> Result<Option<(Vec<ReflogEntry>, Option<String>)>, GitError> {
    if worktree.exists() {
        let out = match run_git(
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
            Ok(out) => out,
            // A broken worktree registration; the empty-output case below is
            // what a merely disabled/absent reflog produces (exit 0).
            Err(GitError::Command { .. }) => return Ok(None),
            Err(other) => return Err(other),
        };
        let head_log = parse_reflog(&out);
        if head_log.is_empty() {
            return Ok(None);
        }
        let fallback = repo::current_branch(worktree)?;
        return Ok(Some((head_log, fallback)));
    }

    let Some(admin) = admin_gitdir(repo_path, worktree)? else {
        return Ok(None); // already pruned (or never a linked worktree): no evidence
    };
    let Some(id) = admin.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Ok(None);
    };
    let head_ref = format!("worktrees/{id}/HEAD");
    let out = match run_git(
        repo_path,
        [
            "--no-optional-locks",
            "log",
            "-g",
            "--date=unix",
            REFLOG_FORMAT,
            &head_ref,
            "--",
        ],
    ) {
        Ok(out) => out,
        Err(GitError::Command { .. }) => return Ok(None),
        Err(other) => return Err(other),
    };
    let head_log = parse_reflog(&out);
    if head_log.is_empty() {
        return Ok(None);
    }
    // The admin dir still holds the worktree's HEAD file — the same fallback
    // a live worktree would answer via `current_branch`.
    let fallback = match head::read_head(&admin) {
        Some(Head::Branch(name)) => Some(name),
        _ => None,
    };
    Ok(Some((head_log, fallback)))
}

/// The admin dir `<common>/worktrees/<id>` whose `gitdir` pointer names this
/// worktree path — the worktree's identity that outlives its directory (until
/// `git worktree prune`). `None` when no admin entry matches.
fn admin_gitdir(repo_path: &Path, worktree: &Path) -> Result<Option<PathBuf>, GitError> {
    let worktrees = head::git_common_dir(repo_path)?.join("worktrees");
    let Ok(entries) = std::fs::read_dir(&worktrees) else {
        return Ok(None); // a repo with no linked worktrees has no such dir
    };
    for entry in entries.flatten() {
        let admin = entry.path();
        let Ok(pointer) = std::fs::read_to_string(admin.join("gitdir")) else {
            continue;
        };
        // The pointer is `<worktree-path>/.git`; its parent is the worktree.
        let matches = PathBuf::from(pointer.trim())
            .parent()
            .is_some_and(|recorded| paths_match(recorded, worktree));
        if matches {
            return Ok(Some(admin));
        }
    }
    Ok(None)
}

/// Whether two spellings name the same worktree path. Git records the
/// REALPATH in the `gitdir` pointer while callers pass the path as stored
/// (e.g. `/var/…` vs macOS's canonical `/private/var/…`), and the worktree
/// itself may be GONE — so the symlinks are resolved on the surviving PARENT
/// directories and only the leaf names compared directly.
fn paths_match(recorded: &Path, worktree: &Path) -> bool {
    if recorded == worktree {
        return true;
    }
    let canonical_leaf = |p: &Path| -> Option<PathBuf> {
        Some(p.parent()?.canonicalize().ok()?.join(p.file_name()?))
    };
    match (canonical_leaf(recorded), canonical_leaf(worktree)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// The local branches that were CREATED in the worktree at `worktree`, in
/// branch-list (refname) order.
///
/// Callable while the worktree exists AND after its directory was deleted
/// externally (the admin record carries the evidence until a prune) — but
/// always BEFORE `git worktree remove`/`prune`, which destroy that record.
pub fn created_branches(repo_path: &Path, worktree: &Path) -> Result<Vec<String>, GitError> {
    let Some((head_log, fallback)) = head_evidence(repo_path, worktree)? else {
        return Ok(Vec::new());
    };
    let initial = initial_branch(&head_log, fallback.as_deref());

    // Only the initial branch and the checkout TARGETS recorded in this
    // worktree's own log can ever be attributed — no other branch needs its
    // reflog read at all. That keeps the sweep at a few subprocesses instead
    // of one per repo branch: this runs under the per-repo lock at close
    // time, and closed panes deliberately leave their branches behind, so a
    // long-lived repo holds hundreds.
    let mut wanted: HashSet<&str> = head_log
        .iter()
        .filter_map(|e| checkout_move(&e.message).map(|(_, to)| to))
        .collect();
    wanted.extend(initial);

    let mut created = Vec::new();
    for branch in repo::list_branches(repo_path)? {
        if !wanted.contains(branch.as_str()) {
            continue;
        }
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

    fn entry(ts: u64, new_sha: &str, message: &str) -> ReflogEntry {
        ReflogEntry {
            ts,
            new_sha: new_sha.to_string(),
            message: message.to_string(),
        }
    }

    /// A typical worktree HEAD log, newest first: born at 100 on `born` (tip
    /// A), switched to a fresh `inside` at 200 (still tip A — `switch -c`
    /// stays put), then VISITED pre-existing `other` at 300 (tip B).
    fn head_log() -> Vec<ReflogEntry> {
        vec![
            entry(300, "B", "checkout: moving from inside to other"),
            entry(200, "A", "checkout: moving from born to inside"),
            entry(100, "A", ""),
        ]
    }

    #[test]
    fn parses_selectors_shas_messages_and_the_bare_birth_line() {
        let parsed = parse_reflog(
            "HEAD@{300}\tabc\tcheckout: moving from a to b\nHEAD@{100}\tdef\t\nHEAD@{50}\nnot a reflog line\n",
        );
        // The tab-less variant and the trailing-tab birth variant both parse;
        // the garbage line is dropped.
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].ts, 300);
        assert_eq!(parsed[0].new_sha, "abc");
        assert_eq!(parsed[0].message, "checkout: moving from a to b");
        assert_eq!(parsed[1].ts, 100);
        assert_eq!(parsed[1].new_sha, "def");
        assert_eq!(parsed[1].message, "");
        assert_eq!(parsed[2].ts, 50);
    }

    #[test]
    fn parses_the_admin_ref_selector_of_a_gone_worktree() {
        // Addressed from the main repo, the selector carries the ref path.
        let parsed =
            parse_reflog("worktrees/wt-1/HEAD@{700}\tabc\tcheckout: moving from a to b\n");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].ts, 700);
    }

    #[test]
    fn initial_branch_is_the_oldest_checkout_source_else_the_fallback() {
        assert_eq!(initial_branch(&head_log(), Some("current")), Some("born"));
        // Never switched: the current branch is the one it was born on.
        let unswitched = vec![entry(100, "A", "")];
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

    #[test]
    fn a_visit_moving_to_a_diverged_tip_is_rejected_on_shas() {
        let log = head_log();
        // `other` was visited at 300 moving A→B: even if its creation second
        // coincided (a trusted-source bystander, `git branch other HEAD`), the
        // old/new disagreement proves the checkout didn't create it.
        assert!(!is_created_here(&log, Some("born"), "other", 300));
        // The documented residual: with COINCIDING tips the same shape passes
        // — same-second, same-commit adoption is beyond reflog evidence.
        let flat = vec![
            entry(300, "A", "checkout: moving from inside to other"),
            entry(200, "A", "checkout: moving from born to inside"),
            entry(100, "A", ""),
        ];
        assert!(is_created_here(&flat, Some("born"), "other", 300));
    }

    #[test]
    fn only_head_and_full_sha_creation_sources_are_trusted() {
        assert!(trusted_creation("branch: Created from HEAD"));
        assert!(trusted_creation(&format!(
            "branch: Created from {}",
            "a1b2c3d4e5".repeat(4)
        )));
        // A branch NAME as the source marks a standalone `git branch X` /
        // `switch -c X <name>` — proves nothing about where it ran.
        assert!(!trusted_creation("branch: Created from master"));
        assert!(!trusted_creation("branch: Created from kd/ws/1"));
        // A short sha is a name to git's resolver, not a full oid.
        assert!(!trusted_creation("branch: Created from a1b2c3d"));
        // Non-creation records never count.
        assert!(!trusted_creation("branch: Reset to HEAD"));
        assert!(!trusted_creation("commit (initial): init"));
    }
}
