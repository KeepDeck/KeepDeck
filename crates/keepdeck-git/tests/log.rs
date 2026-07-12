//! Integration tests for log/merge-base/range-diff — a real `git` against a
//! throwaway repo shaped like an agent worktree: a base branch, a feature
//! branch with commits, an uncommitted edit on top.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_git::{diff, log, repo};

static COUNTER: AtomicU64 = AtomicU64::new(0);

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

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed in {}", dir.display());
}

/// A repo on `main` with one commit, then a `kd/test/1` branch with two more
/// commits (one of them a rename) and an uncommitted edit.
fn init_forked_repo() -> PathBuf {
    let dir = unique_dir("repo");
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.email", "test@keepdeck.ai"]);
    git(&dir, &["config", "user.name", "KeepDeck Test"]);
    fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "init"]);

    git(&dir, &["checkout", "-q", "-b", "kd/test/1"]);
    fs::write(dir.join("feature.ts"), "export const x = 1;\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "add feature"]);
    git(&dir, &["mv", "feature.ts", "renamed.ts"]);
    git(&dir, &["commit", "-q", "-m", "rename feature"]);

    fs::write(dir.join("README.md"), "hello worktree\n").unwrap(); // uncommitted
    dir
}

#[test]
fn merge_base_finds_the_fork_point() {
    let repo_dir = init_forked_repo();

    let main_sha = repo::resolve_commit(&repo_dir, "main").unwrap();
    let fork = repo::merge_base(&repo_dir, "main", "HEAD").expect("merge-base");
    assert_eq!(fork.as_deref(), Some(main_sha.as_str()));

    // An unresolvable rev is an answer, not an error.
    assert_eq!(repo::merge_base(&repo_dir, "no-such-branch", "HEAD").unwrap(), None);

    fs::remove_dir_all(&repo_dir).ok();
}

#[test]
fn log_walks_a_range_newest_first_and_caps() {
    let repo_dir = init_forked_repo();
    let fork = repo::merge_base(&repo_dir, "main", "HEAD").unwrap().unwrap();

    let commits = log::log(&repo_dir, Some(&format!("{fork}..HEAD")), 50).expect("log");
    assert_eq!(commits.len(), 2, "two branch commits since the fork");
    assert_eq!(commits[0].subject, "rename feature");
    assert_eq!(commits[1].subject, "add feature");
    assert_eq!(commits[0].author, "KeepDeck Test");
    assert!(commits[0].timestamp > 0);
    assert_eq!(commits[0].sha.len(), 40);

    // The cap applies inside the range too.
    let capped = log::log(&repo_dir, Some(&format!("{fork}..HEAD")), 1).unwrap();
    assert_eq!(capped.len(), 1);
    assert_eq!(capped[0].subject, "rename feature");

    // No range walks from HEAD — the full history, still capped.
    let all = log::log(&repo_dir, None, 50).unwrap();
    assert_eq!(all.len(), 3);

    fs::remove_dir_all(&repo_dir).ok();
}

#[test]
fn changed_files_and_diff_cover_a_range_and_the_working_tree() {
    let repo_dir = init_forked_repo();
    let fork = repo::merge_base(&repo_dir, "main", "HEAD").unwrap().unwrap();

    // Committed range only: the branch added a file and renamed it — with -M
    // that folds into ONE added entry (net view), plus nothing for README
    // (its edit is uncommitted).
    let committed = diff::changed_files(&repo_dir, &fork, Some("HEAD")).expect("range files");
    assert_eq!(committed.len(), 1, "{committed:?}");
    assert_eq!(committed[0].code, 'A');
    assert_eq!(committed[0].path, "renamed.ts");

    // Against the working tree (`to: None`): the uncommitted README edit joins.
    let with_tree = diff::changed_files(&repo_dir, &fork, None).expect("tree files");
    let paths: Vec<&str> = with_tree.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"renamed.ts"), "{paths:?}");
    assert!(paths.contains(&"README.md"), "{paths:?}");

    // Per-file range diff carries the committed content…
    let ranged = diff::diff_file_range(&repo_dir, "renamed.ts", &fork, Some("HEAD")).unwrap();
    assert!(ranged.contains("+export const x = 1;"), "{ranged}");
    // …and the working-tree variant sees the uncommitted edit.
    let live = diff::diff_file_range(&repo_dir, "README.md", &fork, None).unwrap();
    assert!(live.contains("+hello worktree"), "{live}");

    fs::remove_dir_all(&repo_dir).ok();
}
