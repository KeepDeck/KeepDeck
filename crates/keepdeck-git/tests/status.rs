//! Integration tests for status/diff — a real `git` against a throwaway repo.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_git::{diff, status};

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
    fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "init"]);
    dir
}

#[test]
fn clean_repo_reports_branch_and_no_entries() {
    let repo = init_repo();

    let st = status::status(&repo).expect("status");
    assert!(st.branch.is_some(), "on a branch after init");
    assert!(!st.detached);
    assert!(st.oid.is_some(), "HEAD exists after the first commit");
    assert_eq!(st.upstream, None);
    assert_eq!(st.ahead, None);
    assert!(st.entries.is_empty(), "clean tree has no entries");

    fs::remove_dir_all(&repo).ok();
}

#[test]
fn sees_staged_unstaged_untracked_and_renames() {
    let repo = init_repo();

    // Unstaged edit, then a second staged file, an untracked file, and a
    // staged rename — the whole v1 entry zoo in one status call.
    fs::write(repo.join("README.md"), "hello world\n").unwrap();
    fs::write(repo.join("staged.txt"), "new\n").unwrap();
    git(&repo, &["add", "staged.txt"]);
    fs::write(repo.join("scratch.txt"), "wip\n").unwrap();

    let st = status::status(&repo).expect("status");
    let by_path = |p: &str| {
        st.entries
            .iter()
            .find(|e| e.path == p)
            .unwrap_or_else(|| panic!("entry for {p} in {:?}", st.entries))
    };

    let readme = by_path("README.md");
    assert_eq!((readme.staged, readme.unstaged), ('.', 'M'));

    let staged = by_path("staged.txt");
    assert_eq!(staged.staged, 'A');
    assert!(!staged.untracked);

    let scratch = by_path("scratch.txt");
    assert!(scratch.untracked);

    // Commit, then a staged rename carries the old path.
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "wip"]);
    git(&repo, &["mv", "staged.txt", "renamed.txt"]);
    let st = status::status(&repo).expect("status after mv");
    let renamed = st
        .entries
        .iter()
        .find(|e| e.path == "renamed.txt")
        .expect("renamed entry");
    assert_eq!(renamed.staged, 'R');
    assert_eq!(renamed.orig_path.as_deref(), Some("staged.txt"));

    fs::remove_dir_all(&repo).ok();
}

#[test]
fn reports_ahead_behind_against_an_upstream() {
    let repo = init_repo();

    // Fake an upstream at HEAD (no real remote: the remote + tracking config is
    // written directly — `--set-upstream-to` insists on a configured remote,
    // and upstream resolution maps through the remote's fetch refspec).
    git(&repo, &["config", "remote.origin.url", "."]);
    git(
        &repo,
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/origin/*",
        ],
    );
    git(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    let branch = status::status(&repo).unwrap().branch.expect("on a branch");
    git(&repo, &["config", &format!("branch.{branch}.remote"), "origin"]);
    git(
        &repo,
        &[
            "config",
            &format!("branch.{branch}.merge"),
            "refs/heads/main",
        ],
    );
    fs::write(repo.join("ahead.txt"), "x\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "ahead"]);

    let st = status::status(&repo).expect("status");
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert_eq!(st.ahead, Some(1));
    assert_eq!(st.behind, Some(0));

    fs::remove_dir_all(&repo).ok();
}

#[test]
fn status_takes_no_index_lock() {
    let repo = init_repo();
    fs::write(repo.join("README.md"), "edited\n").unwrap();

    // A held index.lock means another git process is mid-write. Plain
    // `git status` would refresh the index and fail on the lock;
    // `--no-optional-locks` must read straight through it.
    let gitdir = repo.join(".git");
    fs::write(gitdir.join("index.lock"), "").unwrap();

    let st = status::status(&repo).expect("status must not need index.lock");
    assert!(st.entries.iter().any(|e| e.path == "README.md"));

    fs::remove_dir_all(&repo).ok();
}

#[test]
fn diffs_worktree_and_staged_changes() {
    let repo = init_repo();

    fs::write(repo.join("README.md"), "goodbye\n").unwrap();
    let unstaged = diff::diff_file(&repo, "README.md", false).expect("worktree diff");
    assert!(unstaged.contains("-hello"), "old line in diff: {unstaged}");
    assert!(unstaged.contains("+goodbye"), "new line in diff: {unstaged}");

    // Nothing staged yet → empty staged diff.
    let staged = diff::diff_file(&repo, "README.md", true).expect("staged diff");
    assert!(staged.is_empty());

    git(&repo, &["add", "README.md"]);
    let staged = diff::diff_file(&repo, "README.md", true).expect("staged diff");
    assert!(staged.contains("+goodbye"));
    let unstaged = diff::diff_file(&repo, "README.md", false).expect("worktree diff");
    assert!(unstaged.is_empty(), "everything staged → no worktree diff");

    fs::remove_dir_all(&repo).ok();
}
