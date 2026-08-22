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
use std::path::Path;

use crate::worktree_arm::{ensure_excluded, prune_manifests, remove_excluded};

/// What arming plants in a pane's cwd — the directory git must stay blind to,
/// and the one codex reads its skills from.
const PLANTED: &str = ".agents";

/// The codex-facing arm: `<cwd>/.agents/skills` → the staged bare view, for
/// every pane spawn cwd. A real (non-symlink) entry there is the user's own
/// and is left alone; a foreign symlink (target outside KeepDeck's skills
/// root) likewise; a `.agents` that is itself a FILE or a SYMLINK is the
/// user's arrangement and is never written through. Wholly best-effort per
/// root — one odd cwd must not take the workspace's staging down — and the
/// successfully armed cwds are returned for the armed manifest.
/// A spawn cwd we did not arm because something of the USER's is in the
/// way. Only that: a cwd that is simply gone is not a refusal, and
/// neither is an IO fault — both would tell the user to move a file
/// they never had.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillArmRefusal {
    pub root: String,
    pub reason: String,
}

/// One arming pass (mirrors the TS wire, camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillArmReport {
    pub armed: Vec<String>,
    pub refused: Vec<SkillArmRefusal>,
}

/// What one cwd's arming came to.
///
/// THREE states, not two. `Ok(true)`/`Ok(false)` used to fold "we armed
/// it" and "we left it alone" and "the user's file is in the way" into
/// one bit, which is why the refusals were invisible; a two-state
/// Option would fold the first two back together and record a cwd that
/// does not exist as armed.
enum Armed {
    /// Our link is in place.
    Yes,
    /// Nothing to arm and nothing to report: the cwd is gone or was
    /// never a directory. NOT a refusal — the user did nothing.
    Absent,
    /// Something of the user's holds the spot.
    Refused(&'static str),
}

pub(super) fn arm_roots(
    root: &Path,
    staged_skills: &Path,
    spawn_roots: &[String],
) -> SkillArmReport {
    let mut report = SkillArmReport::default();
    for wt in spawn_roots {
        match arm_one(root, staged_skills, Path::new(wt)) {
            Ok(Armed::Yes) => report.armed.push(wt.clone()),
            Ok(Armed::Absent) => {}
            Ok(Armed::Refused(reason)) => report.refused.push(SkillArmRefusal {
                root: wt.clone(),
                reason: reason.to_string(),
            }),
            // A FAULT, never a refusal: a busy disk must not read as
            // "move your file".
            Err(e) => log::warn!("skills: arming {wt} failed: {e}"),
        }
    }
    report
}

/// Arm one spawn cwd.
fn arm_one(root: &Path, staged_skills: &Path, wt: &Path) -> io::Result<Armed> {
    if !wt.is_dir() {
        return Ok(Armed::Absent);
    }
    let agents = wt.join(".agents");
    // `.agents` existing as anything but a real directory (a file, or a
    // symlink into the user's own tree) is the user's — creating our link
    // through it would write inside THEIR target.
    match fs::symlink_metadata(&agents) {
        Ok(meta) if !meta.file_type().is_dir() => {
            return Ok(Armed::Refused(
                "a file or link named .agents is already there — it is yours, so nothing was planted",
            ))
        }
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
                return Ok(Armed::Refused(
                    ".agents/skills points somewhere else — it is not ours to replace",
                ));
            }
        }
        // The user's own real .agents/skills — hands off.
        Ok(_) => {
            return Ok(Armed::Refused(
                ".agents/skills is your own directory — nothing was planted",
            ))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(&agents)?;
            symlink_dir(staged_skills, &link)?;
        }
        Err(e) => return Err(e),
    }
    if let Err(e) = ensure_excluded(wt, PLANTED) {
        log::warn!("skills: exclude line for {} failed: {e}", wt.display());
    }
    Ok(Armed::Yes)
}

/// Remove OUR symlinks (and a `.agents` dir they leave empty) from the
/// given spawn cwds, and drop the matching `info/exclude` lines arming
/// added. Anything not provably ours stays. Deliberately does NOT touch
/// the armed manifests: [`record_armed`] (stage) is their only writer and
/// [`prune_manifests`] their only reader — a stale entry costs one idempotent
/// re-disarm at the next boot, which the module accepts by contract.
pub(super) fn disarm_roots(root: &Path, spawn_roots: &[String]) -> io::Result<()> {
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
                if let Err(e) = remove_excluded(Path::new(wt), PLANTED) {
                    log::warn!("skills: exclude cleanup for {wt} failed: {e}");
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Sweep the manifests of workspaces that no longer exist, taking OUR
/// symlinks out of the cwds they recorded — the crash path, where the deck no
/// longer knows the workspace but its worktrees survived.
pub(super) fn prune_armed(root: &Path, live: &[String]) -> io::Result<()> {
    prune_manifests(root, live, "skills", |cwds| disarm_roots(root, cwds))
}

/// A link is ours iff it points inside KeepDeck's skills root.
fn link_is_ours(link: &Path, skills_root: &Path) -> bool {
    fs::read_link(link).is_ok_and(|target| target.starts_with(skills_root))
}

#[cfg(unix)]
pub(super) fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
pub(super) fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
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

    /// THE VOCABULARY, one pin per arm. Each says what the user is told,
    /// because the sentence IS the feature — a refusal nobody can act on
    /// is the silence we started from wearing a banner.

    #[test]
    fn refuses_when_dot_agents_is_the_users_own_file() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        let view = staged_view(&root);
        fs::write(wt.join(".agents"), "mine").unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];

        let report = arm_roots(&root, &view, &roots);

        assert!(report.armed.is_empty());
        assert_eq!(report.refused.len(), 1);
        assert_eq!(report.refused[0].root, roots[0]);
        assert!(report.refused[0].reason.contains(".agents"));
        // Their file is untouched — the refusal is the whole action.
        assert_eq!(fs::read_to_string(wt.join(".agents")).unwrap(), "mine");
    }

    #[test]
    fn refuses_when_dot_agents_skills_points_somewhere_else() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        let view = staged_view(&root);
        let theirs = root.parent().unwrap().join("their-skills");
        fs::create_dir_all(&theirs).unwrap();
        fs::create_dir_all(wt.join(".agents")).unwrap();
        std::os::unix::fs::symlink(&theirs, wt.join(".agents").join("skills")).unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];

        let report = arm_roots(&root, &view, &roots);

        assert!(report.armed.is_empty());
        assert_eq!(report.refused.len(), 1);
        assert!(report.refused[0].reason.contains("not ours to replace"));
        // Still aimed where they aimed it.
        assert_eq!(
            fs::read_link(wt.join(".agents").join("skills")).unwrap(),
            theirs,
        );
    }

    #[test]
    fn refuses_when_dot_agents_skills_is_the_users_real_directory() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        let view = staged_view(&root);
        fs::create_dir_all(wt.join(".agents").join("skills").join("theirs")).unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];

        let report = arm_roots(&root, &view, &roots);

        assert!(report.armed.is_empty());
        assert_eq!(report.refused.len(), 1);
        assert!(report.refused[0].reason.contains("your own directory"));
        assert!(wt.join(".agents").join("skills").join("theirs").is_dir());
    }

    #[test]
    fn a_cwd_that_is_not_there_is_silent_never_a_refusal() {
        // The arm the user did nothing to cause: a worktree removed under
        // us, or a cwd that never existed. Reporting it would tell them to
        // move a file they never had — the feature lying.
        let (_tmp, root) = root();
        let view = staged_view(&root);
        let roots = vec![root.parent().unwrap().join("gone").to_string_lossy().into_owned()];

        let report = arm_roots(&root, &view, &roots);

        assert!(report.armed.is_empty());
        assert!(report.refused.is_empty());
    }

    #[test]
    fn arms_a_plain_main_checkout_cwd() {
        let (_tmp, root) = root();
        let view = staged_view(&root);
        let repo = root.parent().unwrap().join("checkout");
        fs::create_dir_all(repo.join(".git")).unwrap();

        let armed = arm_roots(&root, &view, &[repo.to_string_lossy().into_owned()]);

        assert_eq!(armed.armed, vec![repo.to_string_lossy().into_owned()]);
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

        assert!(arm_roots(&root, &view, &roots).armed.is_empty());
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

        assert!(armed.armed.is_empty());
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

        prune_armed(&root, &["ws-1".into()]).unwrap();
        assert!(root.join("armed").join("ws-dead").exists());
    }
}
