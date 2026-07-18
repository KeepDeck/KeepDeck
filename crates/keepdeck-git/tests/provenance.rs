//! Integration tests for reflog provenance — a real `git` against a throwaway
//! repo, with `GIT_COMMITTER_DATE` pinning reflog timestamps so the same-second
//! collisions the attribution guards against are reproduced deterministically.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_git::provenance;

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A unique temp dir under the system temp root (no `tempfile` dependency).
fn unique_dir(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "keepdeck-git-{label}-{}-{nanos}-{n}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Run a git command in `dir`, asserting it succeeds (test setup helper).
fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed in {}", dir.display());
}

/// Like [`git`], but with the committer date — and therefore every reflog
/// entry this command writes — pinned to `ts` (git's raw `<unix> <tz>` form).
fn git_at(dir: &Path, ts: u64, args: &[&str]) {
    let status = Command::new("git")
        .env("GIT_COMMITTER_DATE", format!("{ts} +0000"))
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed in {}", dir.display());
}

/// Initialize a repo with a single commit; returns its path.
fn init_repo() -> PathBuf {
    let dir = unique_dir("repo");
    git(&dir, &["init", "-q"]);
    git(&dir, &["config", "user.email", "test@keepdeck.ai"]);
    git(&dir, &["config", "user.name", "KeepDeck Test"]);
    fs::write(dir.join("README.md"), "hello").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "init"]);
    dir
}

const BIRTH: u64 = 1_700_000_100;
const INSIDE: u64 = 1_700_000_200;
const LATER: u64 = 1_700_000_300;

/// The full provenance matrix in one worktree lifetime: a branch born with the
/// worktree, one switched-to inside it, and the two look-alikes that must NOT
/// be claimed — a pre-existing branch created the same second as the worktree,
/// and a `git branch` (no checkout) sharing a second with a real switch.
#[test]
fn attributes_only_branches_born_in_the_worktree() {
    let repo_dir = init_repo();
    // Created in the MAIN worktree in the same second the agent worktree is
    // born — a timestamp-only match would claim it.
    git_at(&repo_dir, BIRTH, &["branch", "pre-existing"]);

    let wt_root = unique_dir("wt");
    let wt = wt_root.join("agent-1");
    git_at(
        &repo_dir,
        BIRTH,
        &["worktree", "add", "-q", "-b", "born-with-wt", wt.to_str().unwrap()],
    );

    git_at(&wt, INSIDE, &["switch", "-q", "-c", "switched-inside"]);
    // Created inside, never checked out — leaves no trace in the worktree's
    // HEAD log, and shares its second with the switch above: the documented
    // unattributable case, kept on purpose.
    git_at(&wt, INSIDE, &["branch", "no-checkout"]);
    // Created inside via two-step `branch` + `switch` — the checkout pairs up,
    // but the creation is NAME-sourced ("Created from switched-inside"), which
    // the trust guard rejects: a documented safe-direction miss.
    git_at(&wt, INSIDE, &["branch", "two-step"]);
    git_at(&wt, INSIDE, &["switch", "-q", "two-step"]);
    // Visiting a foreign branch must not adopt it.
    git_at(&wt, LATER, &["switch", "-q", "pre-existing"]);

    let created = provenance::created_branches(&repo_dir, &wt).expect("provenance");
    assert_eq!(created, ["born-with-wt", "switched-inside"]);

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

/// KeepDeck's own create shape: `worktree add -b <branch> <path> <sha>` records
/// the pinned base sha as the creation source — it must stay attributable.
#[test]
fn a_pinned_base_birth_branch_is_claimed() {
    let repo_dir = init_repo();
    let sha = {
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo_dir)
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("rev-parse");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    let wt_root = unique_dir("wt");
    let wt = wt_root.join("agent-1");
    git_at(
        &repo_dir,
        BIRTH,
        &["worktree", "add", "-q", "-b", "kd/pinned/1", wt.to_str().unwrap(), &sha],
    );

    let created = provenance::created_branches(&repo_dir, &wt).expect("provenance");
    assert_eq!(created, ["kd/pinned/1"]);

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

/// The reproduced false-claim, attach arm: `git branch X && git worktree add
/// wt X` inside ONE second. The attach's birth reflog is byte-identical to a
/// `-b` creation's — the trust guard (X is name-sourced) is what rejects it.
#[test]
fn a_same_second_attach_is_not_claimed() {
    let repo_dir = init_repo();
    git_at(&repo_dir, BIRTH, &["branch", "adopted"]);

    let wt_root = unique_dir("wt");
    let wt = wt_root.join("agent-1");
    git_at(
        &repo_dir,
        BIRTH,
        &["worktree", "add", "-q", wt.to_str().unwrap(), "adopted"],
    );

    let created = provenance::created_branches(&repo_dir, &wt).expect("provenance");
    assert!(created.is_empty(), "claimed a same-second attach: {created:?}");

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

/// The trust guard's blind spot, covered by the sha check: `git branch Y
/// HEAD` creates WITHOUT a checkout yet with a trusted source, so a
/// same-second visit of Y pairs on timestamp, name, AND source — but once the
/// worktree's tip has diverged from Y's, the checkout entry's old/new sides
/// disagree and the visit is rejected.
#[test]
fn a_same_second_head_sourced_visit_of_a_diverged_tip_is_not_claimed() {
    let repo_dir = init_repo();
    let wt_root = unique_dir("wt");
    let wt = wt_root.join("agent-1");
    git_at(
        &repo_dir,
        BIRTH,
        &["worktree", "add", "-q", "-b", "born-with-wt", wt.to_str().unwrap()],
    );
    // Diverge the worktree from the main repo's HEAD.
    fs::write(wt.join("work.txt"), "wip").unwrap();
    git(&wt, &["add", "."]);
    git(&wt, &["commit", "-q", "-m", "wip"]);

    // A trusted-source bystander born in the MAIN repo, visited here in the
    // same second.
    git_at(&repo_dir, LATER, &["branch", "bystander", "HEAD"]);
    git_at(&wt, LATER, &["switch", "-q", "bystander"]);

    let created = provenance::created_branches(&repo_dir, &wt).expect("provenance");
    assert_eq!(created, ["born-with-wt"], "the bystander was claimed");

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

/// The reproduced false-claim, visit arm: a branch created elsewhere and
/// switched-to here inside the same second pairs by timestamp AND name — only
/// its name-sourced creation record tells it apart.
#[test]
fn a_same_second_visit_is_not_claimed() {
    let repo_dir = init_repo();
    let wt_root = unique_dir("wt");
    let wt = wt_root.join("agent-1");
    git_at(
        &repo_dir,
        BIRTH,
        &["worktree", "add", "-q", "-b", "born-with-wt", wt.to_str().unwrap()],
    );

    git_at(&repo_dir, INSIDE, &["branch", "foreign"]);
    git_at(&wt, INSIDE, &["switch", "-q", "foreign"]);

    let created = provenance::created_branches(&repo_dir, &wt).expect("provenance");
    assert_eq!(created, ["born-with-wt"], "the visited branch was claimed");

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

/// An externally-deleted worktree DIRECTORY doesn't destroy the evidence: the
/// admin record keeps the HEAD reflog until a prune, and attribution keeps
/// working through it. After the prune, nothing is claimed.
#[test]
fn a_gone_directory_stays_attributable_until_prune() {
    let repo_dir = init_repo();
    let wt_root = unique_dir("wt");
    let wt = wt_root.join("agent-1");
    git_at(
        &repo_dir,
        BIRTH,
        &["worktree", "add", "-q", "-b", "born-with-wt", wt.to_str().unwrap()],
    );
    git_at(&wt, INSIDE, &["switch", "-q", "-c", "switched-inside"]);

    fs::remove_dir_all(&wt).unwrap();

    let created = provenance::created_branches(&repo_dir, &wt).expect("provenance");
    assert_eq!(created, ["born-with-wt", "switched-inside"]);

    git(&repo_dir, &["worktree", "prune"]);
    let after = provenance::created_branches(&repo_dir, &wt).expect("provenance");
    assert!(after.is_empty(), "claimed after prune: {after:?}");

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

/// A worktree that attached an EXISTING branch (`worktree add` without `-b`)
/// owns nothing — not even the branch it was born holding.
#[test]
fn an_attached_existing_branch_is_not_claimed() {
    let repo_dir = init_repo();
    git_at(&repo_dir, BIRTH, &["branch", "adopted"]);

    let wt_root = unique_dir("wt");
    let wt = wt_root.join("agent-1");
    git_at(
        &repo_dir,
        LATER,
        &["worktree", "add", "-q", wt.to_str().unwrap(), "adopted"],
    );

    let created = provenance::created_branches(&repo_dir, &wt).expect("provenance");
    assert!(created.is_empty(), "claimed: {created:?}");

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

/// With SEVERAL gone-but-unpruned worktrees, each keeps its own branches —
/// the admin record is matched by its gitdir pointer, never by "whatever
/// admin dir comes first".
#[test]
fn each_gone_worktree_keeps_its_own_branches() {
    let repo_dir = init_repo();
    let wt_root = unique_dir("wt");
    let one = wt_root.join("agent-1");
    let two = wt_root.join("agent-2");
    git_at(
        &repo_dir,
        BIRTH,
        &["worktree", "add", "-q", "-b", "branch-one", one.to_str().unwrap()],
    );
    git_at(
        &repo_dir,
        LATER,
        &["worktree", "add", "-q", "-b", "branch-two", two.to_str().unwrap()],
    );
    fs::remove_dir_all(&one).unwrap();
    fs::remove_dir_all(&two).unwrap();

    let of_one = provenance::created_branches(&repo_dir, &one).expect("provenance one");
    let of_two = provenance::created_branches(&repo_dir, &two).expect("provenance two");
    assert_eq!(of_one, ["branch-one"]);
    assert_eq!(of_two, ["branch-two"]);

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

/// Expired reflogs destroy the evidence; the answer must collapse to "nothing
/// attributable" — never an error, never a guess.
#[test]
fn expired_reflogs_attribute_nothing() {
    let repo_dir = init_repo();
    let wt_root = unique_dir("wt");
    let wt = wt_root.join("agent-1");
    git_at(
        &repo_dir,
        BIRTH,
        &["worktree", "add", "-q", "-b", "born-with-wt", wt.to_str().unwrap()],
    );
    git_at(&wt, INSIDE, &["switch", "-q", "-c", "switched-inside"]);

    git(&repo_dir, &["reflog", "expire", "--expire=now", "--all"]);

    let created = provenance::created_branches(&repo_dir, &wt).expect("provenance");
    assert!(created.is_empty(), "claimed without evidence: {created:?}");

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}
