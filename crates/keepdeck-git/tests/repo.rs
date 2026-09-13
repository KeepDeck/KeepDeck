//! Integration tests for the repo helpers around HEAD — a real `git` against
//! throwaway repositories in the states a changes view meets: unborn,
//! on a branch, detached.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_git::repo;

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

/// `git init` and nothing else: HEAD names a branch no commit sits behind.
fn init_unborn() -> PathBuf {
    let dir = unique_dir("unborn");
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.email", "test@keepdeck.ai"]);
    git(&dir, &["config", "user.name", "KeepDeck Test"]);
    dir
}

fn commit_readme(dir: &Path) {
    fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "init"]);
}

#[test]
fn an_unborn_branch_has_a_name_and_no_commit() {
    let dir = init_unborn();

    assert_eq!(repo::current_branch(&dir).unwrap().as_deref(), Some("main"));
    assert_eq!(repo::head_commit(&dir).unwrap(), None);
    assert!(repo::list_branches(&dir).unwrap().is_empty());
    // The strict resolver still refuses: for a caller naming a revision, an
    // absent one is an error.
    assert!(repo::resolve_commit(&dir, "HEAD").is_err());

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_branch_listing_stops_at_its_cap_in_refname_order() {
    let dir = init_unborn();
    commit_readme(&dir);
    git(&dir, &["branch", "a-first"]);
    git(&dir, &["branch", "b-second"]);
    git(&dir, &["branch", "c-third"]);

    let all = repo::list_branches(&dir).unwrap();
    assert_eq!(all, vec!["a-first", "b-second", "c-third", "main"]);
    let capped = repo::list_branches_up_to(&dir, 2).unwrap();
    assert_eq!(capped, vec!["a-first", "b-second"]);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_branch_and_a_detached_head_read_as_themselves() {
    let dir = init_unborn();
    commit_readme(&dir);

    assert_eq!(repo::current_branch(&dir).unwrap().as_deref(), Some("main"));
    let head = repo::head_commit(&dir).unwrap().expect("a commit behind HEAD");
    assert_eq!(head, repo::resolve_commit(&dir, "HEAD").unwrap());

    git(&dir, &["checkout", "-q", "--detach"]);
    assert_eq!(repo::current_branch(&dir).unwrap(), None);
    assert_eq!(repo::head_commit(&dir).unwrap().as_deref(), Some(head.as_str()));

    fs::remove_dir_all(&dir).ok();
}
