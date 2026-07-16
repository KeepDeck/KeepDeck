//! Integration tests for `keepdeck-git` — they drive a real `git` against a
//! throwaway repository in a temp dir and assert the worktree round-trip.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_git::{head, repo, worktree, Head};

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

/// Only a work tree's ROOT is attachable. `is_git_repo` says "true" for every
/// subdirectory of a repo, so classifying on it would offer to attach an agent
/// to `<repo>/src` — landing it on the main branch with no isolation at all.
#[test]
fn only_the_worktree_root_counts_as_a_worktree() {
    let repo_dir = init_repo();
    let subdir = repo_dir.join("src");
    fs::create_dir_all(&subdir).unwrap();

    assert!(repo::is_worktree_root(&repo_dir), "the root itself");
    assert!(
        repo::is_git_repo(&subdir),
        "a subdir IS inside the work tree — the trap this guards"
    );
    assert!(!repo::is_worktree_root(&subdir), "but it is not the root");

    // A linked worktree has its own root, and that root is attachable.
    let linked = unique_dir("linked");
    let wt = linked.join("wt-1");
    let base = repo::resolve_commit(&repo_dir, "HEAD").unwrap();
    worktree::add(&repo_dir, &wt, "kd/probe-root", &base).expect("add worktree");
    assert!(repo::is_worktree_root(&wt), "a linked worktree's root");
    assert!(!repo::is_worktree_root(&linked), "its parent is not a repo");

    let plain = unique_dir("plain");
    assert!(!repo::is_worktree_root(&plain), "a non-repo dir");
    assert!(
        !repo::is_worktree_root(&plain.join("nope")),
        "a path that does not exist"
    );

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&linked).ok();
    fs::remove_dir_all(&plain).ok();
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

#[test]
fn lists_local_branches_alphabetically_excluding_remotes() {
    let repo_dir = init_repo();
    let initial = repo::current_branch(&repo_dir).unwrap().expect("on a branch");

    // Created out of order; the listing must come back sorted by refname.
    git(&repo_dir, &["branch", "zeta"]);
    git(&repo_dir, &["branch", "alpha"]);
    git(&repo_dir, &["branch", "kd/mid/1"]);
    // A remote-tracking ref (no real remote needed) — must NOT be listed.
    git(&repo_dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);

    let mut expected = vec!["alpha".to_string(), "kd/mid/1".to_string(), initial, "zeta".to_string()];
    expected.sort();
    assert_eq!(repo::list_branches(&repo_dir).expect("list branches"), expected);

    fs::remove_dir_all(&repo_dir).ok();
}

#[test]
fn resolves_the_default_branch_from_the_remote_head() {
    let repo_dir = init_repo();
    // No remote at all → no default branch (an answer, not an error).
    assert_eq!(repo::default_branch(&repo_dir).unwrap(), None);

    git(&repo_dir, &["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
    git(
        &repo_dir,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"],
    );
    assert_eq!(
        repo::default_branch(&repo_dir).unwrap(),
        Some("trunk".to_string())
    );

    fs::remove_dir_all(&repo_dir).ok();
}

#[test]
fn add_from_remote_tracking_base_sets_no_upstream() {
    let repo_dir = init_repo();
    // A remote-tracking base branch: without `--no-track`, `worktree add -b`
    // would adopt it as the new branch's upstream.
    git(&repo_dir, &["update-ref", "refs/remotes/origin/base", "HEAD"]);

    let wt_root = unique_dir("wt");
    let wt = wt_root.join("kd-notrack-1");
    worktree::add(&repo_dir, &wt, "kd/notrack/1", "origin/base").expect("add worktree");

    // An upstream materializes as branch.<name>.merge; --get exits non-zero
    // when the key is absent — which is exactly what we require.
    let merge_key = Command::new("git")
        .arg("-C")
        .arg(&repo_dir)
        .args(["config", "--get", "branch.kd/notrack/1.merge"])
        .status()
        .expect("run git config");
    assert!(
        !merge_key.success(),
        "a branch based on a remote-tracking ref must not track it as upstream"
    );

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}

#[test]
fn head_tracks_checkouts_inside_a_worktree() {
    let repo_dir = init_repo();
    let base = repo::resolve_commit(&repo_dir, "HEAD").expect("resolve base");

    let wt_root = unique_dir("wt");
    let wt = wt_root.join("kd-head-1");
    worktree::add(&repo_dir, &wt, "kd/head/1", &base).expect("add worktree");

    // The worktree's private gitdir is where its HEAD lives — distinct from the
    // main repo's, so per-worktree checkouts are observable independently.
    let wt_gitdir = head::git_dir(&wt).expect("worktree gitdir");
    let main_gitdir = head::git_dir(&repo_dir).expect("main gitdir");
    assert_ne!(wt_gitdir, main_gitdir);
    assert!(wt_gitdir.starts_with(&main_gitdir), "linked worktree gitdir nests under .git");

    assert_eq!(head::read_head(&wt_gitdir), Some(Head::Branch("kd/head/1".into())));

    // A checkout inside the worktree rewrites ITS HEAD; the main repo's stays.
    let main_before = head::read_head(&main_gitdir).expect("main head");
    git(&wt, &["checkout", "-q", "-b", "kd/head/renamed"]);
    assert_eq!(head::read_head(&wt_gitdir), Some(Head::Branch("kd/head/renamed".into())));
    assert_eq!(head::read_head(&main_gitdir), Some(main_before));

    // Detaching lands on the commit itself.
    git(&wt, &["checkout", "-q", "--detach"]);
    assert_eq!(head::read_head(&wt_gitdir), Some(Head::Detached(base)));

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(&wt_root).ok();
}
