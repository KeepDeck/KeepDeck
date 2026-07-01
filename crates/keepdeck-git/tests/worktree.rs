//! Integration tests for `keepdeck-git` — they drive a real `git` against a
//! throwaway repository in a temp dir and assert the worktree round-trip.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_git::{repo, worktree};

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

#[test]
fn detects_repo_and_resolves_head() {
    let repo_dir = init_repo();
    assert!(repo::is_git_repo(&repo_dir));

    let non_repo = unique_dir("plain");
    assert!(!repo::is_git_repo(&non_repo));

    let sha = repo::resolve_commit(&repo_dir, "HEAD").expect("resolve HEAD");
    assert_eq!(sha.len(), 40, "expected a full commit sha, got {sha:?}");

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&non_repo).ok();
}

#[test]
fn adds_lists_then_removes_a_worktree() {
    let repo_dir = init_repo();
    let base = repo::resolve_commit(&repo_dir, "HEAD").unwrap();

    let wt_root = unique_dir("wt");
    let wt = wt_root.join("agent-1");

    worktree::add(&repo_dir, &wt, "kd/test/1", &base).expect("add worktree");
    assert!(wt.join("README.md").exists(), "worktree should be checked out");

    // git reports canonical (realpath) worktree paths; compare against that.
    let wt_canon = fs::canonicalize(&wt).unwrap();
    let listed = worktree::list(&repo_dir).expect("list");
    let found = listed
        .iter()
        .find(|w| w.path == wt_canon)
        .expect("the new worktree should be listed");
    assert_eq!(found.branch.as_deref(), Some("kd/test/1"));
    assert_eq!(found.head.as_deref(), Some(base.as_str()));

    assert!(repo::branch_exists(&repo_dir, "kd/test/1").unwrap());
    assert!(!repo::branch_exists(&repo_dir, "kd/test/absent").unwrap());

    // Clean right after creation; dirty after an edit.
    assert!(!worktree::is_dirty(&wt).unwrap());
    fs::write(wt.join("scratch.txt"), "wip").unwrap();
    assert!(worktree::is_dirty(&wt).unwrap());

    // Force-remove (it's intentionally dirty here) and confirm it's gone.
    worktree::remove(&repo_dir, &wt, true).expect("remove worktree");
    assert!(!wt.exists(), "worktree dir should be removed");
    let after = worktree::list(&repo_dir).unwrap();
    assert!(
        after.iter().all(|w| w.path != wt_canon),
        "removed worktree should not be listed"
    );

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

#[test]
fn discards_a_worktree_then_deletes_its_branch() {
    // The real "delete on close" path: remove the worktree, then delete the now
    // free branch. The branch sits at HEAD (nothing new committed), so even the
    // safe `-d` accepts it.
    let repo_dir = init_repo();
    let base = repo::resolve_commit(&repo_dir, "HEAD").unwrap();

    let wt_root = unique_dir("wt");
    let wt = wt_root.join("kd-test-1");
    worktree::add(&repo_dir, &wt, "kd/test/1", &base).expect("add worktree");
    assert!(repo::branch_exists(&repo_dir, "kd/test/1").unwrap());

    // A branch checked out in a worktree can't be deleted — remove first.
    worktree::remove(&repo_dir, &wt, false).expect("remove clean worktree");
    repo::delete_branch(&repo_dir, "kd/test/1", false).expect("delete merged branch");
    assert!(
        !repo::branch_exists(&repo_dir, "kd/test/1").unwrap(),
        "branch should be gone after delete"
    );

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

#[test]
fn safe_delete_refuses_unmerged_branch_but_force_removes_it() {
    let repo_dir = init_repo();
    let start = repo::current_branch(&repo_dir).unwrap().expect("on a branch");

    // A branch with a commit that lives nowhere else — unmerged work.
    git(&repo_dir, &["checkout", "-q", "-b", "kd/unmerged"]);
    fs::write(repo_dir.join("wip.txt"), "work").unwrap();
    git(&repo_dir, &["add", "."]);
    git(&repo_dir, &["commit", "-q", "-m", "wip"]);
    git(&repo_dir, &["checkout", "-q", &start]);

    // `-d` protects unmerged work; `-D` (force) discards it.
    assert!(
        repo::delete_branch(&repo_dir, "kd/unmerged", false).is_err(),
        "safe delete must refuse an unmerged branch"
    );
    assert!(repo::branch_exists(&repo_dir, "kd/unmerged").unwrap());

    repo::delete_branch(&repo_dir, "kd/unmerged", true).expect("force delete");
    assert!(!repo::branch_exists(&repo_dir, "kd/unmerged").unwrap());

    fs::remove_dir_all(&repo_dir).ok();
}
