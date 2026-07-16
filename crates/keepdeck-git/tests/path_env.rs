//! Regression test for the launchd stripped-PATH failure.
//!
//! A GUI-launched macOS app inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.
//! `git worktree add` then dies (exit 128) in any repo whose checkout runs a
//! required filter named by a bare command outside that PATH — the real case
//! is git-lfs from Homebrew (`filter.lfs.process = git-lfs filter-process`,
//! `filter.lfs.required = true`). `run_git` must hand its child the augmented
//! PATH so git's own subprocesses resolve like they do in the user's terminal.
//!
//! This file holds a single test on purpose: it mutates the process `PATH`
//! and relies on pinning `keepdeck_env::augmented_path()` (a `OnceLock`)
//! while the filter's bin dir is still visible — sharing the process with
//! other tests would race both.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_git::{repo, worktree};

/// A unique temp dir under the system temp root (no `tempfile` dependency).
fn unique_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "keepdeck-git-{label}-{}-{nanos}",
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

#[test]
fn worktree_add_resolves_required_filters_beyond_the_inherited_path() {
    let root = unique_dir("stripped-path");

    // A pass-through filter that proves it ran, installed as a BARE name in a
    // private bin dir — the stand-in for Homebrew's git-lfs.
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let marker = root.join("filter-ran");
    let script = bin.join("kd-test-filter");
    fs::write(
        &script,
        format!("#!/bin/sh\ntouch \"{}\"\nexec cat\n", marker.display()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    }

    // Pin the augmented PATH while the bin dir is on the process PATH, exactly
    // as it is when the app computes it at startup with the user's real PATH.
    let original_path = std::env::var_os("PATH").expect("test process has a PATH");
    let with_bin = std::env::join_paths(
        std::iter::once(bin.clone()).chain(std::env::split_paths(&original_path)),
    )
    .unwrap();
    std::env::set_var("PATH", &with_bin);
    let augmented = keepdeck_env::augmented_path();
    assert!(
        std::env::split_paths(augmented).any(|d| d == bin),
        "augmented PATH must see the filter's bin dir, or this test proves nothing"
    );

    // A repo whose files pass through a REQUIRED bare-name filter (the git-lfs
    // shape). Setup runs on the full PATH, so the clean side resolves.
    let repo_dir = root.join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    git(&repo_dir, &["init", "-q"]);
    git(&repo_dir, &["config", "user.email", "test@keepdeck.ai"]);
    git(&repo_dir, &["config", "user.name", "KeepDeck Test"]);
    git(&repo_dir, &["config", "filter.cap.clean", "kd-test-filter"]);
    git(&repo_dir, &["config", "filter.cap.smudge", "kd-test-filter"]);
    git(&repo_dir, &["config", "filter.cap.required", "true"]);
    fs::write(repo_dir.join(".gitattributes"), "*.dat filter=cap\n").unwrap();
    fs::write(repo_dir.join("data.dat"), "payload").unwrap();
    git(&repo_dir, &["add", "."]);
    git(&repo_dir, &["commit", "-q", "-m", "filtered file"]);
    let base = repo::resolve_commit(&repo_dir, "HEAD").expect("resolve HEAD");

    // Simulate the launchd environment, then create the worktree: checkout
    // runs the smudge filter inside git's child, which must inherit the
    // augmented PATH — the stripped one no longer contains the filter.
    std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    fs::remove_file(&marker).ok();
    let wt = root.join("wt");
    let result = worktree::add(&repo_dir, &wt, "kd/test/stripped-path", &base);
    std::env::set_var("PATH", &original_path);

    result.expect("worktree add must survive a stripped inherited PATH");
    assert!(marker.exists(), "the smudge filter must actually have run");
    assert_eq!(
        fs::read_to_string(wt.join("data.dat")).unwrap(),
        "payload",
        "the filtered file must be checked out intact"
    );

    fs::remove_dir_all(&root).ok();
}
