//! Real-git coverage for the fork-point ladder, with its COST measured in git
//! processes: a history read used to fan out over every registered worktree
//! (three ref reads each, plus a reflog walk per unmatched candidate), so ten
//! worktrees made one read spawn eighty-odd processes. Seconds would vary
//! with the machine; the process count is the design.
//!
//! Alone in its file on purpose: the spawn counter is process-wide, and a
//! sibling test's git calls would land in the difference.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use keepdeck_git::{fork, repo, spawns, worktree, worktree_base};

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed in {}", dir.display());
}

fn init_repo() -> tempfile::TempDir {
    let root = tempfile::tempdir().expect("temp dir");
    git(root.path(), &["init", "-q", "-b", "main"]);
    git(root.path(), &["config", "user.email", "test@keepdeck.ai"]);
    git(root.path(), &["config", "user.name", "KeepDeck Test"]);
    fs::write(root.path().join("README.md"), "hello\n").unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-q", "-m", "init"]);
    root
}

/// A KeepDeck-managed worktree: cut from `main`, its base recorded the way
/// provisioning records it.
fn managed_worktree(repo_dir: &Path, root: &Path, branch: &str) -> (PathBuf, String) {
    let base = repo::resolve_commit(repo_dir, "main").expect("base");
    let path = root.join(branch.replace('/', "-"));
    worktree::add(repo_dir, &path, branch, &base).expect("add worktree");
    worktree_base::record(&path, &base, Some("refs/heads/main"), &format!("refs/heads/{branch}"))
        .expect("record base");
    (path, base)
}

/// The default branch is what `origin/HEAD` names; a throwaway repo has no
/// remote, so point one at itself the way a clone would look.
fn fake_origin_main(repo_dir: &Path) {
    git(repo_dir, &["update-ref", "refs/remotes/origin/main", "main"]);
    git(
        repo_dir,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    );
}

fn commit_file(dir: &Path, name: &str) {
    fs::write(dir.join(name), format!("{name}\n")).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", name]);
}

/// The ceiling for a managed worktree asking about its own HEAD: the current
/// branch (1), its own three private refs (3), and the merge-bases that place
/// the fork (up to 3). The scan this replaces cost `2 + 3 × worktrees` before
/// a single merge-base — with the four worktrees below, fourteen or more.
const OWN_HEAD_MAX_SPAWNS: u64 = 8;

#[test]
fn a_managed_worktree_finds_its_fork_without_scanning_its_siblings() {
    let repo_dir = init_repo();
    let root = tempfile::tempdir().expect("worktree root");
    let (_first, _) = managed_worktree(repo_dir.path(), root.path(), "kd/one");
    let (_second, _) = managed_worktree(repo_dir.path(), root.path(), "kd/two");
    let (_third, _) = managed_worktree(repo_dir.path(), root.path(), "kd/three");
    let (fourth, base) = managed_worktree(repo_dir.path(), root.path(), "kd/four");
    commit_file(&fourth, "own.ts");
    let tip = repo::resolve_commit(&fourth, "HEAD").expect("tip");

    let before = spawns();
    let fork = fork::fork_point(&fourth, "HEAD", &tip, None).expect("fork point");
    let cost = spawns() - before;

    assert_eq!(fork.as_deref(), Some(base.as_str()), "the fork is the recorded base");
    assert!(
        cost <= OWN_HEAD_MAX_SPAWNS,
        "a managed worktree's own fork cost {cost} git processes; the scan is back"
    );
}

#[test]
fn browsing_a_sibling_branch_by_name_still_finds_its_recorded_base() {
    let repo_dir = init_repo();
    let root = tempfile::tempdir().expect("worktree root");
    let (one, base) = managed_worktree(repo_dir.path(), root.path(), "kd/one");
    let (two, _) = managed_worktree(repo_dir.path(), root.path(), "kd/two");
    commit_file(&one, "one.ts");
    // main moves on after both were cut: the recorded base must still win.
    commit_file(repo_dir.path(), "later.ts");
    let one_tip = repo::resolve_commit(&one, "HEAD").expect("tip");

    // Asked from a SIBLING worktree, by branch name — the fast path does not
    // apply (`two` recorded a different branch), the scan does.
    let fork = fork::fork_point(&two, "kd/one", &one_tip, None).expect("fork point");
    assert_eq!(fork.as_deref(), Some(base.as_str()));
}

#[test]
fn a_worktree_without_metadata_falls_back_to_the_default_branch() {
    let repo_dir = init_repo();
    fake_origin_main(repo_dir.path());
    let root = tempfile::tempdir().expect("worktree root");
    let base = repo::resolve_commit(repo_dir.path(), "main").expect("base");
    let legacy = root.path().join("legacy");
    worktree::add(repo_dir.path(), &legacy, "kd/legacy", &base).expect("add worktree");
    commit_file(&legacy, "legacy.ts");
    let tip = repo::resolve_commit(&legacy, "HEAD").expect("tip");

    let fork = fork::fork_point(&legacy, "HEAD", &tip, None).expect("fork point");
    assert_eq!(fork.as_deref(), Some(base.as_str()));

    // On the base itself there is nothing to measure.
    let at_base = fork::fork_point(repo_dir.path(), "HEAD", &base, None).expect("fork point");
    assert_eq!(at_base, None);
}

#[test]
fn an_explicit_base_outranks_everything() {
    let repo_dir = init_repo();
    let root = tempfile::tempdir().expect("worktree root");
    let (one, _) = managed_worktree(repo_dir.path(), root.path(), "kd/one");
    commit_file(&one, "a.ts");
    let mid = repo::resolve_commit(&one, "HEAD").expect("mid");
    git(&one, &["branch", "picked"]);
    commit_file(&one, "b.ts");
    let tip = repo::resolve_commit(&one, "HEAD").expect("tip");

    let fork = fork::fork_point(&one, "HEAD", &tip, Some("picked")).expect("fork point");
    assert_eq!(fork.as_deref(), Some(mid.as_str()));
}

#[test]
fn an_explicit_base_that_does_not_resolve_is_an_error_not_no_fork() {
    let repo_dir = init_repo();
    let root = tempfile::tempdir().expect("worktree root");
    let (one, _) = managed_worktree(repo_dir.path(), root.path(), "kd/typo");
    commit_file(&one, "a.ts");
    let tip = repo::resolve_commit(&one, "HEAD").expect("tip");

    // A person typed a base that is not there: saying "no fork point" would
    // hide the typo behind a plausible, wrong history.
    let err = fork::fork_point(&one, "HEAD", &tip, Some("no-such-base")).unwrap_err();
    assert!(
        matches!(err, keepdeck_git::GitError::Command { status: Some(128), .. }),
        "{err:?}"
    );

    // A base with no shared history is still an answer, not an error.
    git(&one, &["checkout", "-q", "--orphan", "island"]);
    git(&one, &["commit", "-q", "--allow-empty", "-m", "island"]);
    git(&one, &["checkout", "-q", "kd/typo"]);
    let fork = fork::fork_point(&one, "HEAD", &tip, Some("island")).expect("an answer");
    assert_eq!(fork, None);
}
