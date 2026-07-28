//! Real-git coverage for worktree-private base metadata.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use keepdeck_git::{repo, worktree, worktree_base};

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed in {}", dir.display());
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
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

fn add_worktree(repo_dir: &Path, root: &Path, branch: &str) -> (PathBuf, String) {
    let base = repo::resolve_commit(repo_dir, "main").expect("base");
    let path = root.join(branch.replace('/', "-"));
    worktree::add(repo_dir, &path, branch, &base).expect("add worktree");
    (path, base)
}

#[test]
fn records_isolated_private_refs_and_resolves_the_fork() {
    let repo_dir = init_repo();
    let worktrees = tempfile::tempdir().expect("worktree root");
    let (first, base) = add_worktree(repo_dir.path(), worktrees.path(), "kd/first");
    let (second, _) = add_worktree(repo_dir.path(), worktrees.path(), "kd/second");

    worktree_base::record(&first, &base, Some("refs/heads/main")).expect("record metadata");

    assert_eq!(
        worktree_base::read(&first).expect("read metadata"),
        worktree_base::BaseMetadata {
            branch_ref: Some("refs/heads/main".to_string()),
            at_creation: Some(base.clone()),
        }
    );
    assert_eq!(
        worktree_base::read(&second).expect("read sibling metadata"),
        worktree_base::BaseMetadata::default(),
        "private refs must not leak into a sibling worktree"
    );
    assert_eq!(
        worktree_base::fork_point(&first, "HEAD").expect("fork point"),
        Some(base.clone())
    );
    assert!(
        worktree_base::record(&first, &base, Some("refs/heads/main")).is_err(),
        "the creation marker must not be overwritten"
    );
}

#[test]
fn symbolic_base_tracks_a_descendant_rebase() {
    let repo_dir = init_repo();
    let worktrees = tempfile::tempdir().expect("worktree root");
    let (agent, creation_sha) = add_worktree(repo_dir.path(), worktrees.path(), "kd/agent");
    worktree_base::record(&agent, &creation_sha, Some("refs/heads/main")).expect("record metadata");

    fs::write(agent.join("agent.txt"), "agent\n").unwrap();
    git(&agent, &["add", "."]);
    git(&agent, &["commit", "-q", "-m", "agent work"]);

    fs::write(repo_dir.path().join("main.txt"), "main\n").unwrap();
    git(repo_dir.path(), &["add", "."]);
    git(repo_dir.path(), &["commit", "-q", "-m", "main moves"]);
    let new_main = repo::resolve_commit(repo_dir.path(), "main").unwrap();

    git(&agent, &["rebase", "-q", "main"]);

    assert_eq!(
        worktree_base::fork_point(&agent, "HEAD").expect("fork after rebase"),
        Some(new_main),
        "the symbolic base must follow the selected branch, not its old tip"
    );
}

#[test]
fn pinned_creation_commit_survives_base_branch_deletion() {
    let repo_dir = init_repo();
    let worktrees = tempfile::tempdir().expect("worktree root");
    let (agent, creation_sha) = add_worktree(repo_dir.path(), worktrees.path(), "kd/fallback");
    worktree_base::record(&agent, &creation_sha, Some("refs/heads/main")).expect("record metadata");

    fs::write(agent.join("agent.txt"), "agent\n").unwrap();
    git(&agent, &["add", "."]);
    git(&agent, &["commit", "-q", "-m", "agent work"]);

    git(repo_dir.path(), &["checkout", "-q", "--detach"]);
    git(repo_dir.path(), &["branch", "-q", "-D", "main"]);

    assert_eq!(
        worktree_base::fork_point(&agent, "HEAD").expect("fallback fork"),
        Some(creation_sha),
        "the exact creation marker must outlive the selected base branch"
    );
}

#[test]
fn metadata_is_removed_with_the_worktree_administration_dir() {
    let repo_dir = init_repo();
    let worktrees = tempfile::tempdir().expect("worktree root");
    let (agent, base) = add_worktree(repo_dir.path(), worktrees.path(), "kd/remove");
    worktree_base::record(&agent, &base, Some("refs/heads/main")).expect("record metadata");

    let private_git_dir = PathBuf::from(git_out(&agent, &["rev-parse", "--absolute-git-dir"]));
    let marker_path = PathBuf::from(git_out(
        &agent,
        &[
            "rev-parse",
            "--git-path",
            worktree_base::BASE_AT_CREATION_REF,
        ],
    ));
    assert!(private_git_dir.exists());
    assert!(
        marker_path.exists(),
        "creation marker must be a real private ref"
    );

    worktree::remove(repo_dir.path(), &agent, false).expect("remove worktree");

    assert!(
        !private_git_dir.exists(),
        "Git must remove the private metadata with the worktree record"
    );
    assert!(!marker_path.exists(), "the private ref must be gone too");
}
