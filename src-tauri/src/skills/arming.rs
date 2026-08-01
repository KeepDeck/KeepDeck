//! Arming a pane's working directory so codex can find the staged skills.
//!
//! Codex has no injection door at all (no flag, no env, no config key), but
//! it reads the STANDARD location `.agents/skills` at its starting cwd (and
//! up to the repo root) once, at session start. So — per the user's rule
//! "skills live in the launched CLI's cwd, period" — every pane spawn cwd of
//! a workspace is armed with a SYMLINK `.agents/skills` → the staged bare
//! view, and a `/.agents/` line in the nearest repo's shared `info/exclude`
//! keeps git blind to it (a non-git cwd just skips the exclude). A symlink
//! pointing into KeepDeck's home is provably OURS — a real directory there is
//! the user's and is never touched.
//!
//! Every cwd armed with a symlink is recorded in an `armed/<wsId>` manifest —
//! [`record_armed`] (staging) is its only writer, [`prune_manifests`] its only
//! reader — so a workspace that dies in a crash can still be disarmed at the
//! next boot. A cwd claimed by another (possibly dead-but-unpruned) manifest
//! is spared; a link spared on a DEAD claimer's account stays dangling until
//! boot prune — bounded staleness, accepted.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use crate::state::write_atomic;

/// Where a workspace's armed spawn cwds are remembered, so a boot-time
/// prune can disarm the cwds of a workspace that died in a crash (the deck
/// no longer knows them; this file does).
pub(crate) fn armed_manifest(root: &Path, ws_id: &str) -> PathBuf {
    root.join("armed").join(ws_id)
}

/// The recorded armed cwds of one workspace (empty when absent/unreadable).
pub(crate) fn manifest_roots(root: &Path, ws_id: &str) -> Vec<String> {
    fs::read(armed_manifest(root, ws_id))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Every cwd some OTHER manifest still claims — a shared cwd must survive
/// one workspace's disarm while another workspace (live, or not yet
/// pruned) runs panes there.
pub(crate) fn claimed_by_others(root: &Path, except_ws: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root.join("armed")) else {
        return Vec::new();
    };
    let mut claimed = Vec::new();
    for entry in entries.flatten() {
        let ws = entry.file_name().to_string_lossy().into_owned();
        if ws == except_ws {
            continue;
        }
        claimed.extend(manifest_roots(root, &ws));
    }
    claimed
}

pub(crate) fn record_armed(root: &Path, ws_id: &str, armed: &[String]) {
    let path = armed_manifest(root, ws_id);
    let result = if armed.is_empty() {
        fs::remove_file(&path).or_else(|e| {
            if e.kind() == ErrorKind::NotFound { Ok(()) } else { Err(e) }
        })
    } else {
        serde_json::to_vec(armed)
            .map_err(io::Error::other)
            .and_then(|json| write_atomic(&path, &json))
    };
    if let Err(e) = result {
        log::warn!("skills: recording armed cwds for {ws_id} failed: {e}");
    }
}

/// The codex-facing arm: `<cwd>/.agents/skills` → the staged bare view, for
/// every pane spawn cwd. A real (non-symlink) entry there is the user's own
/// and is left alone; a foreign symlink (target outside KeepDeck's skills
/// root) likewise; a `.agents` that is itself a FILE or a SYMLINK is the
/// user's arrangement and is never written through. Wholly best-effort per
/// root — one odd cwd must not take the workspace's staging down — and the
/// successfully armed cwds are returned for the armed manifest.
pub(crate) fn arm_roots(root: &Path, staged_skills: &Path, spawn_roots: &[String]) -> Vec<String> {
    let mut armed = Vec::new();
    for wt in spawn_roots {
        match arm_one(root, staged_skills, Path::new(wt)) {
            Ok(true) => armed.push(wt.clone()),
            Ok(false) => {}
            Err(e) => log::warn!("skills: arming {wt} failed: {e}"),
        }
    }
    armed
}

/// Arm one spawn cwd; `Ok(true)` iff OUR link is (now) in place there.
fn arm_one(root: &Path, staged_skills: &Path, wt: &Path) -> io::Result<bool> {
    if !wt.is_dir() {
        return Ok(false);
    }
    let agents = wt.join(".agents");
    // `.agents` existing as anything but a real directory (a file, or a
    // symlink into the user's own tree) is the user's — creating our link
    // through it would write inside THEIR target.
    match fs::symlink_metadata(&agents) {
        Ok(meta) if !meta.file_type().is_dir() => return Ok(false),
        _ => {}
    }
    let link = agents.join("skills");
    match fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if fs::read_link(&link)? == staged_skills {
                // Already correct — content freshness comes from staging.
            } else if link_is_ours(&link, root) {
                fs::remove_file(&link)?;
                symlink_dir(staged_skills, &link)?;
            } else {
                return Ok(false); // someone else's link — hands off
            }
        }
        Ok(_) => return Ok(false), // the user's real .agents/skills — hands off
        Err(e) if e.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(&agents)?;
            symlink_dir(staged_skills, &link)?;
        }
        Err(e) => return Err(e),
    }
    if let Err(e) = ensure_excluded(wt) {
        log::warn!("skills: exclude line for {} failed: {e}", wt.display());
    }
    Ok(true)
}

/// Remove OUR symlinks (and a `.agents` dir they leave empty) from the
/// given spawn cwds, and drop the matching `info/exclude` lines arming
/// added. Anything not provably ours stays. Deliberately does NOT touch
/// the armed manifests: [`record_armed`] (stage) is their only writer and
/// [`prune_manifests`] their only reader — a stale entry costs one idempotent
/// re-disarm at the next boot, which the module accepts by contract.
pub(crate) fn disarm_roots(root: &Path, spawn_roots: &[String]) -> io::Result<()> {
    for wt in spawn_roots {
        let agents = Path::new(wt).join(".agents");
        let link = agents.join("skills");
        match fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() && link_is_ours(&link, root) => {
                fs::remove_file(&link)?;
                // Only vanishes when the link was its sole content.
                let _ = fs::remove_dir(&agents);
                // Symmetry with ensure_excluded: the repo must not keep an
                // ignore line for an arming that no longer exists.
                if let Err(e) = remove_excluded(Path::new(wt)) {
                    log::warn!("skills: exclude cleanup for {wt} failed: {e}");
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Consume the armed manifests of workspaces that no longer exist: their
/// recorded spawn cwds get OUR symlinks removed — the crash path, where the
/// deck no longer knows the workspace but its worktrees survived.
pub(crate) fn prune_manifests(root: &Path, live: &[String]) -> io::Result<()> {
    let manifests = match fs::read_dir(root.join("armed")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in manifests.flatten() {
        let ws = entry.file_name().to_string_lossy().into_owned();
        if live.iter().any(|l| l == &ws) {
            continue;
        }
        // A manifest that won't parse is EVIDENCE of armed cwds we can no
        // longer locate — keep it (and warn) rather than silently deleting
        // the only record; a later fixed pass may still act on it.
        let Some(roots) = fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        else {
            log::warn!(
                "skills: armed manifest for {ws} is unreadable — kept, not disarmed",
            );
            continue;
        };
        // A cwd another workspace still claims keeps its symlink — two
        // workspaces on one folder must not lose arming because one died.
        let claimed = claimed_by_others(root, &ws);
        let ours: Vec<String> = roots.into_iter().filter(|r| !claimed.contains(r)).collect();
        if let Err(e) = disarm_roots(root, &ours) {
            log::warn!("skills: disarming dead workspace {ws} failed: {e}");
        }
        let _ = fs::remove_file(entry.path());
    }
    Ok(())
}

/// Remove the exact anchored `/…/.agents/` line arming appended — nothing
/// else in the user's exclude file is touched (byte-faithful removal lives
/// in `keepdeck_git::exclude`).
fn remove_excluded(armed_root: &Path) -> io::Result<()> {
    match agents_exclusion(armed_root)? {
        Some((common_dir, line)) => keepdeck_git::exclude::remove_line(&common_dir, &line),
        None => Ok(()),
    }
}

/// A link is ours iff it points inside KeepDeck's skills root.
fn link_is_ours(link: &Path, skills_root: &Path) -> bool {
    fs::read_link(link).is_ok_and(|target| target.starts_with(skills_root))
}

#[cfg(unix)]
pub(crate) fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
pub(crate) fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

/// Idempotently append the armed dir's anchored line to the owning repo's
/// SHARED `info/exclude` so it never shows up in git status or a commit
/// (resolution and the byte-faithful edit live in `keepdeck_git::exclude`).
fn ensure_excluded(armed_root: &Path) -> io::Result<()> {
    match agents_exclusion(armed_root)? {
        Some((common_dir, line)) => keepdeck_git::exclude::ensure_line(&common_dir, &line),
        None => Ok(()),
    }
}

/// The owning repo's COMMON git dir plus the anchored `.agents` ignore
/// pattern for an armed cwd — `/.agents/` at the repo root,
/// `/<subdir>/.agents/` below it (forward slashes on every platform: the
/// pattern is git syntax) — or `None` when no ancestor is a git checkout.
/// This module knows only the `.agents` pattern; the git plumbing is
/// `keepdeck_git::exclude`'s.
fn agents_exclusion(armed_root: &Path) -> io::Result<Option<(PathBuf, String)>> {
    let Some(repo) = keepdeck_git::exclude::owning_repo(armed_root)? else {
        return Ok(None);
    };
    let line = if repo.below_root.is_empty() {
        "/.agents/".to_string()
    } else {
        format!("/{}/.agents/", repo.below_root)
    };
    Ok(Some((repo.common_dir, line)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::test_support::{fake_worktree, root};

    /// The staged bare view arming points a cwd at — one skill, so a test can
    /// assert the skill is reachable THROUGH the link, as codex reads it.
    fn staged_view(root: &Path) -> PathBuf {
        let view = root.join("staging").join("ws-1").join("skills");
        fs::create_dir_all(view.join("review")).unwrap();
        fs::write(view.join("review").join("SKILL.md"), "x").unwrap();
        view
    }

    fn exclude_of(repo: &Path) -> String {
        fs::read_to_string(repo.join(".git").join("info").join("exclude")).unwrap()
    }

    #[test]
    fn arms_a_plain_main_checkout_cwd() {
        let (_tmp, root) = root();
        let view = staged_view(&root);
        let repo = root.parent().unwrap().join("checkout");
        fs::create_dir_all(repo.join(".git")).unwrap();

        let armed = arm_roots(&root, &view, &[repo.to_string_lossy().into_owned()]);

        assert_eq!(armed, vec![repo.to_string_lossy().into_owned()]);
        let link = repo.join(".agents").join("skills");
        assert!(link.join("review").join("SKILL.md").exists());
        assert!(exclude_of(&repo).contains("/.agents/"));
    }

    #[test]
    fn a_subdir_cwd_is_armed_with_an_anchored_exclude_in_the_owning_repo() {
        let (_tmp, root) = root();
        let view = staged_view(&root);
        let repo = root.parent().unwrap().join("checkout");
        let cwd = repo.join("packages").join("app");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&cwd).unwrap();

        arm_roots(&root, &view, &[cwd.to_string_lossy().into_owned()]);

        // The link sits AT the cwd (codex reads its starting cwd first),
        // and the exclude anchors that exact path in the repo's exclude.
        assert!(cwd.join(".agents").join("skills").join("review").exists());
        assert!(exclude_of(&repo).lines().any(|l| l == "/packages/app/.agents/"));
    }

    #[test]
    fn a_users_real_agents_dir_is_never_touched() {
        let (_tmp, root) = root();
        let view = staged_view(&root);
        let wt = fake_worktree(root.parent().unwrap());
        let theirs = wt.join(".agents").join("skills");
        fs::create_dir_all(theirs.join("their-skill")).unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];

        assert!(arm_roots(&root, &view, &roots).is_empty());
        assert!(theirs.join("their-skill").exists());
        assert!(!fs::symlink_metadata(&theirs).unwrap().file_type().is_symlink());

        // Disarming leaves it alone too.
        disarm_roots(&root, &roots).unwrap();
        assert!(theirs.join("their-skill").exists());
    }

    #[test]
    fn a_dot_agents_file_or_user_symlink_is_skipped_without_failing() {
        let (_tmp, root) = root();
        let view = staged_view(&root);
        let base = root.parent().unwrap();

        // `.agents` is a regular FILE — not ours, and not fatal.
        let with_file = base.join("cwd-file");
        fs::create_dir_all(&with_file).unwrap();
        fs::write(with_file.join(".agents"), "not a dir").unwrap();

        // `.agents` is the user's SYMLINK to their own directory — writing
        // through it would land inside their tree.
        let with_link = base.join("cwd-link");
        let their_tree = base.join("their-agents");
        fs::create_dir_all(&with_link).unwrap();
        fs::create_dir_all(&their_tree).unwrap();
        symlink_dir(&their_tree, &with_link.join(".agents")).unwrap();

        let armed = arm_roots(
            &root,
            &view,
            &[
                with_file.to_string_lossy().into_owned(),
                with_link.to_string_lossy().into_owned(),
            ],
        );

        assert!(armed.is_empty());
        assert_eq!(fs::read_to_string(with_file.join(".agents")).unwrap(), "not a dir");
        assert!(!their_tree.join("skills").exists()); // nothing planted in their tree
    }

    #[test]
    fn disarm_removes_the_exclude_line_and_keeps_the_users_lines() {
        let (_tmp, root) = root();
        let view = staged_view(&root);
        let wt = fake_worktree(root.parent().unwrap());
        let exclude = root
            .parent()
            .unwrap()
            .join("main")
            .join(".git")
            .join("info")
            .join("exclude");
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        fs::write(&exclude, "*.log\n").unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];
        arm_roots(&root, &view, &roots);
        assert!(fs::read_to_string(&exclude).unwrap().contains("/.agents/"));

        disarm_roots(&root, &roots).unwrap();
        let text = fs::read_to_string(&exclude).unwrap();
        assert!(!text.contains("/.agents/"));
        assert!(text.contains("*.log")); // the user's own line survives
    }

    #[test]
    fn disarm_preserves_a_crlf_exclude_files_bytes() {
        // TRAP for the inline lines()+join removal this module once had: a
        // CRLF exclude file must keep every carriage return through an
        // arm/disarm cycle — only OUR line goes.
        let (_tmp, root) = root();
        let view = staged_view(&root);
        let wt = fake_worktree(root.parent().unwrap());
        let exclude = root
            .parent()
            .unwrap()
            .join("main")
            .join(".git")
            .join("info")
            .join("exclude");
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        fs::write(&exclude, "# mine\r\n*.log\r\n").unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];
        arm_roots(&root, &view, &roots);

        disarm_roots(&root, &roots).unwrap();
        let text = fs::read_to_string(&exclude).unwrap();
        assert!(!text.contains("/.agents/"));
        assert!(text.starts_with("# mine\r\n*.log\r\n"), "CRLF mangled: {text:?}");
    }

    #[test]
    fn disarm_spares_a_foreign_symlink_and_company_in_agents() {
        let (_tmp, root) = root();
        let wt = root.parent().unwrap().join("wt");
        let agents = wt.join(".agents");
        fs::create_dir_all(&agents).unwrap();
        // A skills link the USER made (target outside our home) and a
        // sibling file: both must survive our disarm.
        let elsewhere = root.parent().unwrap().join("their-skills");
        fs::create_dir_all(&elsewhere).unwrap();
        symlink_dir(&elsewhere, &agents.join("skills")).unwrap();
        fs::write(agents.join("notes.txt"), "keep").unwrap();

        disarm_roots(&root, &[wt.to_string_lossy().into_owned()]).unwrap();
        assert!(agents.join("skills").exists());
        assert!(agents.join("notes.txt").exists());
    }

    #[test]
    fn an_unreadable_armed_manifest_is_kept_as_evidence() {
        let (_tmp, root) = root();
        fs::create_dir_all(root.join("armed")).unwrap();
        fs::write(root.join("armed").join("ws-dead"), "not json").unwrap();

        prune_manifests(&root, &["ws-1".into()]).unwrap();
        assert!(root.join("armed").join("ws-dead").exists());
    }
}
