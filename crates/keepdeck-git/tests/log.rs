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

/// A revision that spells a git option must be refused as a revision, never
/// obeyed as an option: `--output=<path>` would otherwise write the diff to
/// ANY path, past every containment check the caller made on the repo.
#[test]
fn a_revision_spelled_as_an_option_is_refused_and_writes_nothing() {
    let repo_dir = init_forked_repo();
    let fork = repo::merge_base(&repo_dir, "main", "HEAD").unwrap().unwrap();
    let escape = unique_dir("escape").join("stolen.diff");
    let to = format!("--output={}", escape.display());

    let ranged = diff::diff_file_range(&repo_dir, "README.md", &fork, Some(&to), None);
    assert!(ranged.is_err(), "the option-shaped revision must fail: {ranged:?}");
    assert!(!escape.exists(), "diff_file_range wrote outside the repo");

    let files = diff::changed_files(&repo_dir, &fork, Some(&to));
    assert!(files.is_err(), "the option-shaped revision must fail: {files:?}");
    assert!(!escape.exists(), "changed_files wrote outside the repo");

    // `from` is guarded the same way.
    let from_escape = diff::changed_files(&repo_dir, &to, None);
    assert!(from_escape.is_err(), "{from_escape:?}");
    assert!(!escape.exists());

    fs::remove_dir_all(&repo_dir).ok();
    fs::remove_dir_all(escape.parent().unwrap()).ok();
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
    let ranged =
        diff::diff_file_range(&repo_dir, "renamed.ts", &fork, Some("HEAD"), None).unwrap();
    assert!(ranged.text.contains("+export const x = 1;"), "{}", ranged.text);
    assert!(!ranged.truncated);
    // …and the working-tree variant sees the uncommitted edit.
    let live = diff::diff_file_range(&repo_dir, "README.md", &fork, None, None).unwrap();
    assert!(live.text.contains("+hello worktree"), "{}", live.text);

    fs::remove_dir_all(&repo_dir).ok();
}

/// "Everything since the fork, committed or not" includes the files git has
/// never seen: `git diff <fork>` lists tracked paths only, so a working-tree
/// range appends the untracked ones as `?` entries. A committed range does
/// not, and ignored files stay out either way.
#[test]
fn a_working_tree_range_lists_untracked_files_as_untracked() {
    let repo_dir = init_forked_repo();
    let fork = repo::merge_base(&repo_dir, "main", "HEAD").unwrap().unwrap();
    fs::write(repo_dir.join("scratch.md"), "notes\n").unwrap();
    fs::write(repo_dir.join(".gitignore"), "ignored.log\n").unwrap();
    fs::write(repo_dir.join("ignored.log"), "noise\n").unwrap();

    let with_tree = diff::changed_files(&repo_dir, &fork, None).expect("tree files");
    let scratch = with_tree
        .iter()
        .find(|f| f.path == "scratch.md")
        .expect("the untracked file is listed");
    assert_eq!(scratch.code, '?');
    assert_eq!(scratch.orig_path, None);
    assert!(with_tree.iter().any(|f| f.path == ".gitignore" && f.code == '?'));
    assert!(
        !with_tree.iter().any(|f| f.path == "ignored.log"),
        "ignored files are not work: {with_tree:?}"
    );
    // Tracked changes are still there, before the untracked tail.
    assert!(with_tree.iter().any(|f| f.path == "README.md" && f.code == 'M'));

    let committed = diff::changed_files(&repo_dir, &fork, Some("HEAD")).expect("range files");
    assert!(
        !committed.iter().any(|f| f.code == '?'),
        "a committed range has no untracked files: {committed:?}"
    );

    // A file the fork HAS, dropped from the index but kept on disk, is `D` to
    // the diff and untracked to ls-files: one path, listed once, as the
    // tracked change — the fact with a diff behind it.
    git(&repo_dir, &["rm", "-q", "--cached", "README.md"]);
    let after_rm = diff::changed_files(&repo_dir, &fork, None).expect("tree files");
    let readme: Vec<&diff::ChangedFile> =
        after_rm.iter().filter(|f| f.path == "README.md").collect();
    assert_eq!(readme.len(), 1, "{after_rm:?}");
    assert_eq!(readme[0].code, 'D', "the tracked side wins: {after_rm:?}");

    fs::remove_dir_all(&repo_dir).ok();
}

/// Twenty lines, so a one-line edit after a move still reads as a rename to
/// git's similarity check (a one-liner edited would be 0% similar).
fn twenty_lines(changed: Option<usize>) -> String {
    (1..=20)
        .map(|n| match changed {
            Some(c) if c == n => format!("line {n} edited\n"),
            _ => format!("line {n}\n"),
        })
        .collect()
}

/// A moved file diffs as a rename plus its edit only when the old path is in
/// the pathspec too. Limited to the new path, git cannot pair the rename and
/// reports every line as added — which is what the peek used to show under a
/// header that said `old → new`.
#[test]
fn a_rename_diffs_as_a_rename_only_with_its_old_path() {
    let repo_dir = init_forked_repo();
    fs::write(repo_dir.join("wide.ts"), twenty_lines(None)).unwrap();
    git(&repo_dir, &["add", "wide.ts"]);
    git(&repo_dir, &["commit", "-q", "-m", "add wide"]);

    // Committed: move + one-line edit in one commit.
    git(&repo_dir, &["mv", "wide.ts", "moved.ts"]);
    fs::write(repo_dir.join("moved.ts"), twenty_lines(Some(7))).unwrap();
    git(&repo_dir, &["commit", "-q", "-am", "move wide"]);

    let alone = diff::diff_file_range(&repo_dir, "moved.ts", "HEAD^", Some("HEAD"), None).unwrap();
    assert!(alone.text.contains("new file mode"), "without the old path: {}", alone.text);

    let paired = diff::diff_file_range(
        &repo_dir,
        "moved.ts",
        "HEAD^",
        Some("HEAD"),
        Some("wide.ts"),
    )
    .unwrap();
    assert!(paired.text.contains("rename from wide.ts"), "{}", paired.text);
    assert!(paired.text.contains("rename to moved.ts"), "{}", paired.text);
    assert!(paired.text.contains("+line 7 edited"), "{}", paired.text);
    assert!(!paired.text.contains("new file mode"), "{}", paired.text);
    assert!(!paired.text.contains("+line 1\n"), "the unchanged lines are not added: {}", paired.text);

    // Staged: the same move + edit sitting in the index (status `2 R.`).
    git(&repo_dir, &["mv", "moved.ts", "staged.ts"]);
    fs::write(repo_dir.join("staged.ts"), twenty_lines(Some(12))).unwrap();
    git(&repo_dir, &["add", "-A"]);

    let alone = diff::diff_file(&repo_dir, "staged.ts", true, None).unwrap();
    assert!(alone.text.contains("new file mode"), "without the old path: {}", alone.text);

    let paired = diff::diff_file(&repo_dir, "staged.ts", true, Some("moved.ts")).unwrap();
    assert!(paired.text.contains("rename from moved.ts"), "{}", paired.text);
    assert!(paired.text.contains("+line 12 edited"), "{}", paired.text);
    assert!(!paired.text.contains("new file mode"), "{}", paired.text);

    fs::remove_dir_all(&repo_dir).ok();
}
