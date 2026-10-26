//! Integration tests for `blob::file_at` — a real `git` against a throwaway
//! repo: a committed file, a staged edit, a working-tree edit on top.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_git::{blob, GitError};

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

/// `a.ts` committed as v1, staged as v2, edited to v3 in the working tree.
fn init_repo() -> PathBuf {
    let dir = unique_dir("blob");
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.email", "test@keepdeck.ai"]);
    git(&dir, &["config", "user.name", "KeepDeck Test"]);
    fs::write(dir.join("a.ts"), "const v = 1;\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "v1"]);
    fs::write(dir.join("a.ts"), "const v = 2;\n").unwrap();
    git(&dir, &["add", "."]);
    fs::write(dir.join("a.ts"), "const v = 3;\n").unwrap();
    dir
}

#[test]
fn reads_a_side_at_a_revision_and_in_the_index() {
    let repo = init_repo();
    let committed = blob::file_at(&repo, "a.ts", Some("HEAD"))
        .unwrap()
        .expect("committed");
    assert_eq!(
        (committed.bytes.as_slice(), committed.truncated),
        (b"const v = 1;\n".as_slice(), false)
    );
    let staged = blob::file_at(&repo, "a.ts", None).unwrap().expect("staged");
    assert_eq!(
        (staged.bytes.as_slice(), staged.truncated),
        (b"const v = 2;\n".as_slice(), false)
    );
}

#[test]
fn a_file_that_is_not_there_is_absent_not_an_error() {
    let repo = init_repo();
    fs::write(repo.join("new.ts"), "x\n").unwrap();
    git(&repo, &["add", "new.ts"]);
    assert!(blob::file_at(&repo, "new.ts", Some("HEAD"))
        .unwrap()
        .is_none());
    assert!(blob::file_at(&repo, "gone.ts", None).unwrap().is_none());
    assert!(blob::file_at(&repo, "a.ts", Some("no-such-branch"))
        .unwrap()
        .is_none());
}

#[test]
fn an_unborn_head_has_no_files() {
    let dir = unique_dir("blob-unborn");
    git(&dir, &["init", "-q", "-b", "main"]);
    assert!(blob::file_at(&dir, "a.ts", Some("HEAD")).unwrap().is_none());
}

#[test]
fn a_revision_spelled_as_an_option_or_empty_is_refused() {
    let repo = init_repo();
    for rev in ["--output=/tmp/x", ""] {
        assert!(
            matches!(
                blob::file_at(&repo, "a.ts", Some(rev)),
                Err(GitError::InvalidInput(_))
            ),
            "{rev:?} must be refused"
        );
    }
}

#[test]
fn a_large_file_is_capped_at_a_line_boundary() {
    let repo = init_repo();
    let line = "const filler = 0;\n";
    let big = line.repeat(blob::BLOB_MAX_BYTES / line.len() + 100);
    fs::write(repo.join("big.ts"), &big).unwrap();
    git(&repo, &["add", "big.ts"]);
    let capped = blob::file_at(&repo, "big.ts", None)
        .unwrap()
        .expect("staged");
    assert!(capped.truncated);
    assert!(capped.bytes.len() <= blob::BLOB_MAX_BYTES);
    assert_eq!(capped.bytes.last(), Some(&b'\n'));
}
