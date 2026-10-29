//! Per-workspace staging: the skills a spawning agent is handed.
//!
//! A staging is global + workspace skills merged (a workspace skill wins a
//! name clash) and rebuilt from scratch on every request, so it can never
//! serve a deleted or stale skill. It is one view, `staging/<wsId>/skills/`
//! — the bare standard layout (`<skill>/SKILL.md` at top level) — and each
//! staged SKILL.md as text beside it. A CLI that takes a skills directory is
//! pointed at the view; any other layout a CLI reads is its plugin's to
//! build in its own workspace directory, from the text or from a copy of the
//! view (`fsWrite.copyDir`, which reads it while no staging can swap it).

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use super::bundled::BundledSkill;
use super::library::{sorted_dirs, SKILL_FILE};
use crate::state::write_atomic;

/// Per-workspace locks that serialize `stage()`. Tauri managed state, the
/// `RepoLocks` idiom: overlapping stagings for the SAME workspace share the
/// `.tmp-<ws>` build dir and a multi-step swap — without serialization the
/// loser can delete the winner's published staging and leave a link into it
/// dangling. App-scoped (not a process static) so tests get isolated
/// instances. A poisoned lock (a panicked stage) is recovered — the next
/// stage rebuilds from scratch anyway. The complementary Hard policy and why
/// the two must not merge: see [`crate::keyed_locks`].
#[derive(Clone)]
pub struct SkillsLocks {
    inner: crate::keyed_locks::KeyedLocks<String>,
}

impl Default for SkillsLocks {
    fn default() -> Self {
        Self {
            inner: crate::keyed_locks::KeyedLocks::new(
                crate::keyed_locks::PoisonPolicy::Recover,
            ),
        }
    }
}

impl SkillsLocks {
    fn for_ws(&self, ws_id: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
        self.inner.for_key(ws_id.to_string())
    }

    /// Take a workspace's lock under this map's poison policy.
    fn acquire<'a>(&self, lock: &'a std::sync::Mutex<()>) -> std::sync::MutexGuard<'a, ()> {
        self.inner.acquire(lock)
    }

    /// Run `read` while no staging of `ws_id` runs: its view stays whole and
    /// in place until `read` is done.
    pub(crate) fn holding<T>(&self, ws_id: &str, read: impl FnOnce() -> T) -> T {
        let lock = self.for_ws(ws_id);
        let _held = self.acquire(&lock);
        read()
    }
}

/// The workspace whose published view, `<staging>/<ws>/skills`, holds `path`
/// (both real paths). A build-aside (`.tmp-<ws>`, `.old-<ws>`) is no view.
pub(super) fn view_workspace(staging: &Path, path: &Path) -> Option<String> {
    let mut parts = path.strip_prefix(staging).ok()?.components();
    let ws_id = parts.next()?.as_os_str().to_str()?;
    (parts.next()?.as_os_str() == "skills" && !ws_id.starts_with('.')).then(|| ws_id.to_string())
}

/// A workspace's staging (mirrors the TS `SkillsStagingViews`, camelCase):
/// the bare view's absolute path, and each staged skill's SKILL.md as text,
/// by name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStagingDto {
    pub dir: String,
    pub skills: Vec<StagedSkill>,
}

/// One staged skill as text: the exact bytes its SKILL.md was staged from.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StagedSkill {
    pub name: String,
    pub content: String,
}

/// A library or bundled row the host judged unfit to hand any agent (no
/// usable description). The judgement is the host's TypeScript codec's —
/// the one SKILL.md reader — so this side only skips what it is told,
/// BEFORE the merge: a broken row never shadows a fit same-name one.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedSource {
    /// `global` | `workspace` | `bundled`, the row's `StoredSkill` scope.
    pub scope: String,
    pub ws_id: Option<String>,
    pub name: String,
}

impl ExcludedSource {
    fn names(&self, scope: &str, ws_id: Option<&str>, name: &str) -> bool {
        self.scope == scope && self.ws_id.as_deref() == ws_id && self.name == name
    }
}

pub(super) fn stage(
    locks: &SkillsLocks,
    root: &Path,
    ws_id: &str,
    tier: &[BundledSkill],
    claimed: bool,
    excluded: &[ExcludedSource],
) -> io::Result<Option<SkillStagingDto>> {
    let library = root.join("library");
    let final_dir = root.join("staging").join(ws_id);

    // Overlapping same-ws stagings share the tmp dir and the swap — serialize.
    let lock = locks.for_ws(ws_id);
    let _staging = locks.acquire(&lock);

    // The registry result arrives as a plain bool from the tauri glue —
    // staging logic stays feature-free (the one-directional boundary).
    let sources = collect_sources(&library, ws_id, tier, claimed, excluded);

    // Build aside, then swap: a pane spawning mid-rebuild reads either the
    // old complete view or the new one, never a half-copied one.
    let tmp = root.join("staging").join(format!(".tmp-{ws_id}"));
    match fs::remove_dir_all(&tmp) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
    let view = tmp.join("skills");
    let mut staged: Vec<StagedSkill> = Vec::new();
    for (name, source) in &sources {
        // The two materialization contracts, enforced by the match arms:
        // LIBRARY — a source deleted between collection and here is
        // SKIPPED outright (re-materializing it from the collected bytes
        // would resurrect a deleted skill for one stage). BUNDLED — a
        // constant cannot vanish: the arm is UNCONDITIONAL.
        let dest = view.join(name);
        let content: &str = match source {
            Source::Library { dir, content } => {
                if !copy_dir(dir, &dest)? {
                    let _ = fs::remove_dir_all(&dest);
                    continue;
                }
                content
            }
            Source::Bundled(content) => {
                fs::create_dir_all(&dest)?;
                content
            }
        };
        // The staged SKILL.md is written from the content read at collection
        // time — the same bytes handed out as text below, so a save racing
        // this loop cannot make the file and the text diverge.
        write_atomic(&dest.join(SKILL_FILE), content.as_bytes())?;
        staged.push(StagedSkill { name: name.clone(), content: content.to_string() });
    }
    staged.sort_by(|a, b| a.name.cmp(&b.name));
    fs::create_dir_all(final_dir.parent().unwrap_or(root))?;
    // An emptied library swaps in nothing, so yesterday's view goes with it.
    swap_dir(&tmp, &final_dir, &root.join("staging").join(format!(".old-{ws_id}")))?;
    if staged.is_empty() {
        return Ok(None);
    }
    Ok(Some(SkillStagingDto {
        dir: final_dir.join("skills").to_string_lossy().into_owned(),
        skills: staged,
    }))
}

/// The materialization source: a library skill carries its dir (copy_dir
/// materializes assets) AND its collected content (the staged SKILL.md is
/// written from the bytes read at collection); a bundled skill IS its
/// constant — no dir, no vanish, unconditional.
pub(super) enum Source {
    Library { dir: PathBuf, content: String },
    Bundled(&'static str),
}

/// The workspace's effective skills — global first, workspace overrides by
/// name — with each SKILL.md's content read up front. A skill whose file
/// cannot be read (non-UTF-8, permissions) is SKIPPED with a warning, the
/// same treatment `list()` gives it: one broken skill must not take the
/// whole workspace's staging down.
fn collect_sources(
    library: &Path,
    ws_id: &str,
    tier: &[BundledSkill],
    claimed: bool,
    excluded: &[ExcludedSource],
) -> Vec<(String, Source)> {
    let skip = |scope: &str, ws: Option<&str>, name: &str| {
        excluded.iter().any(|row| row.names(scope, ws, name))
    };
    let mut sources: Vec<(String, Source)> = Vec::new();
    // THE MERGE ORDER (the shadow rule as code): retain-then-push means
    // the LAST source WINS, so the tier enters FIRST — each library
    // scope then shadows it naturally; a ws skill outranks a global one
    // exactly as before. Appending the tier last would INVERT the
    // doctrine. The gate applies per skill: ungated always, gated only
    // while the resolved gate is true (content must obey the same gate as
    // its tools — advice for absent tools is actively misleading).
    for skill in tier.iter().filter(|s| s.gate.is_none() || claimed) {
        // The guard: a skill the host judged to have no usable description
        // stages NOWHERE. A description-less SKILL.md once became a palette
        // command whose empty frontmatter made a CLI refuse its ENTIRE
        // config and killed the agent at spawn; no consumer can choke on
        // what never lands. First-party content is pinned to always pass
        // (the host's bundledContent suite); a skip here means the binary
        // shipped broken and the warn names the const.
        if skip("bundled", None, skill.name) {
            log::warn!(
                "skills: bundled skill {} has no usable description — not staged",
                skill.name
            );
            continue;
        }
        sources.push((skill.name.to_string(), Source::Bundled(skill.content)));
    }
    for (scope, scope_ws) in [("global", None), ("workspace", Some(ws_id))] {
        let dir = match scope_ws {
            None => library.join("global"),
            Some(ws) => library.join("ws").join(ws),
        };
        let Ok(dirs) = sorted_dirs(&dir) else { continue };
        for skill in dirs {
            let name = skill.file_name().unwrap_or_default().to_string_lossy().into_owned();
            // The same guard, BEFORE the retain: skipping after it would
            // have already retained the garbage OVER the tier's valid
            // same-name skill, leaving BOTH dead (the incident's exact
            // shape). Skipping here never gathers the garbage, so the tier's
            // skill stages under the name: the shadow-FALLBACK semantics the
            // merge order exists for.
            if skip(scope, scope_ws, &name) {
                log::warn!(
                    "skills: {} has a SKILL.md with no usable description — not staged (edit or delete it in the library)",
                    skill.display(),
                );
                continue;
            }
            let content = match fs::read_to_string(skill.join(SKILL_FILE)) {
                Ok(content) => content,
                Err(e) if e.kind() == ErrorKind::NotFound => continue,
                Err(e) => {
                    log::warn!(
                        "skills: {} has an unreadable SKILL.md — skipped: {e}",
                        skill.display(),
                    );
                    continue;
                }
            };
            sources.retain(|(existing, _)| *existing != name);
            sources.push((
                name,
                Source::Library {
                    dir: skill,
                    content,
                },
            ));
        }
    }
    sources
}

/// Publish `tmp` at `final_dir` with the smallest possible outage: the old
/// dir is renamed aside (one syscall) rather than deleted in place, so a
/// reader — a link a plugin planted into the view, a CLI pointed at it —
/// sees the target missing only between two renames, not for a whole
/// recursive delete.
fn swap_dir(tmp: &Path, final_dir: &Path, trash: &Path) -> io::Result<()> {
    let _ = fs::remove_dir_all(trash);
    match fs::rename(final_dir, trash) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
    match fs::rename(tmp, final_dir) {
        // A tmp that was never created (nothing materialized) renames
        // nothing — the final_dir's absence above already left it clean.
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
    let _ = fs::remove_dir_all(trash);
    Ok(())
}

/// Copy a skill directory tree (assets included); `Ok(false)` = the whole
/// source vanished mid-stage (a racing delete) and nothing was copied.
/// Symlinks are followed — the library is KeepDeck-authored, a link is the
/// author's own doing. `write_atomic`'s transient `SKILL.md.tmp` sibling is
/// excluded, and an entry that vanishes mid-copy (that same transient being
/// renamed away by a concurrent save) is skipped rather than failing the
/// whole stage.
fn copy_dir(from: &Path, to: &Path) -> io::Result<bool> {
    fs::create_dir_all(to)?;
    let entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == "SKILL.md.tmp" {
            continue;
        }
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            let _ = copy_dir(&entry.path(), &target)?;
        } else {
            match fs::copy(entry.path(), &target) {
                Err(e) if e.kind() == ErrorKind::NotFound => continue,
                other => {
                    other?;
                }
            }
        }
    }
    Ok(true)
}

/// Drop the stagings of workspaces that no longer exist. `.tmp-<id>` /
/// `.old-<id>` build leftovers follow the same liveness rule as the dirs
/// themselves, so an in-flight stage of a LIVE workspace can never lose its
/// build-aside dir to a concurrent prune. The library is user content and is
/// never touched.
pub(super) fn prune_views(root: &Path, live: &[String]) -> io::Result<()> {
    for dir in sorted_dirs(&root.join("staging"))? {
        let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let id = name
            .strip_prefix(".tmp-")
            .or_else(|| name.strip_prefix(".old-"))
            .unwrap_or(&name);
        if live.iter().any(|l| l == id) {
            continue;
        }
        // Best-effort per dir: one stubborn/racing directory must not abort
        // the sweep.
        if let Err(e) = fs::remove_dir_all(&dir) {
            log::warn!("skills: pruning {} failed: {e}", dir.display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::GateKey;
    use crate::skills::library::{delete, list, save};
    use crate::skills::test_support::{global, root, ws};

    /// Library/tier content as an agent needs it: a frontmatter description.
    /// The host excludes anything without one before staging; the skip
    /// itself is pinned by the guard's own tests below.
    fn fm(desc: &str) -> String {
        format!("---\ndescription: {desc}\n---\n{desc}\n")
    }

    fn staged(
        root: &Path,
        ws_id: &str,
        tier: &[BundledSkill],
        claimed: bool,
        excluded: &[ExcludedSource],
    ) -> Option<SkillStagingDto> {
        stage(&SkillsLocks::default(), root, ws_id, tier, claimed, excluded).unwrap()
    }

    #[test]
    fn stage_builds_the_bare_view_with_workspace_override_and_assets() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("global review")).unwrap();
        save(&global(&root), "deploy", &fm("deploy body")).unwrap();
        save(&ws(&root, "ws-1"), "review", &fm("ws review")).unwrap();
        // An asset rides along with its skill.
        fs::write(global(&root).join("deploy").join("notes.txt"), "asset").unwrap();

        let views = staged(&root, "ws-1", &[], false, &[]).unwrap();
        let skills = PathBuf::from(&views.dir);
        assert_eq!(skills, root.join("staging").join("ws-1").join("skills"));
        let review = fs::read_to_string(skills.join("review").join(SKILL_FILE)).unwrap();
        assert_eq!(review, fm("ws review")); // workspace wins the clash
        assert_eq!(fs::read_to_string(skills.join("deploy").join("notes.txt")).unwrap(), "asset");
    }

    #[test]
    fn restaging_drops_deleted_skills() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("x")).unwrap();
        save(&global(&root), "deploy", &fm("x")).unwrap();
        let views = staged(&root, "ws-1", &[], false, &[]).unwrap();

        delete(&global(&root), "deploy").unwrap();
        staged(&root, "ws-1", &[], false, &[]).unwrap();
        let skills = PathBuf::from(&views.dir);
        assert!(skills.join("review").exists());
        assert!(!skills.join("deploy").exists());
    }

    #[test]
    fn empty_library_stages_nothing_and_clears_stale_views() {
        let (_tmp, root) = root();
        assert_eq!(staged(&root, "ws-1", &[], false, &[]), None);

        save(&ws(&root, "ws-1"), "review", &fm("x")).unwrap();
        staged(&root, "ws-1", &[], false, &[]).unwrap();
        delete(&ws(&root, "ws-1"), "review").unwrap();
        assert_eq!(staged(&root, "ws-1", &[], false, &[]), None);
        assert!(!root.join("staging").join("ws-1").exists());
    }

    #[test]
    fn concurrent_same_ws_stagings_serialize_and_end_complete() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("x")).unwrap();
        let root = std::sync::Arc::new(root);
        // ONE lock instance shared by both threads — the app's managed state.
        let locks = SkillsLocks::default();
        for _ in 0..8 {
            let a = std::sync::Arc::clone(&root);
            let b = std::sync::Arc::clone(&root);
            let (la, lb) = (locks.clone(), locks.clone());
            let ta = std::thread::spawn(move || stage(&la, &a, "ws-1", &[], false, &[]).unwrap().unwrap());
            let tb = std::thread::spawn(move || stage(&lb, &b, "ws-1", &[], false, &[]).unwrap().unwrap());
            ta.join().unwrap();
            tb.join().unwrap();
            // Whatever the interleaving, the published staging is complete.
            let staged = root.join("staging").join("ws-1");
            assert!(staged.join("skills").join("review").join(SKILL_FILE).exists());
        }
    }

    #[test]
    fn a_held_view_is_not_swapped_until_its_reader_is_done() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("old")).unwrap();
        let locks = SkillsLocks::default();
        let skill = PathBuf::from(staged(&root, "ws-1", &[], false, &[]).unwrap().dir).join("review").join(SKILL_FILE);
        save(&global(&root), "review", &fm("new")).unwrap();
        let restage = locks.holding("ws-1", || {
            let (root, locks) = (root.clone(), locks.clone());
            let restage = std::thread::spawn(move || stage(&locks, &root, "ws-1", &[], false, &[]).unwrap());
            // Unheld, the stage would have swapped the view by now.
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert_eq!(fs::read_to_string(&skill).unwrap(), fm("old"), "the view moved under its reader");
            restage
        });
        restage.join().unwrap();
        assert_eq!(fs::read_to_string(&skill).unwrap(), fm("new"));
    }

    #[test]
    fn only_a_published_view_is_a_view() {
        let staging = Path::new("/home/skills/staging");
        assert_eq!(view_workspace(staging, &staging.join("ws-1/skills")), Some("ws-1".into()));
        assert_eq!(view_workspace(staging, &staging.join("ws-1/skills/review/scripts")), Some("ws-1".into()));
        for path in [
            staging.join(".tmp-ws-1/skills"),
            staging.join(".old-ws-1/skills/review"),
            staging.join("ws-1"),
            staging.join("ws-1/other"),
            staging.to_path_buf(),
            PathBuf::from("/elsewhere/ws-1/skills"),
        ] {
            assert_eq!(view_workspace(staging, &path), None, "{}", path.display());
        }
    }

    #[test]
    fn an_unreadable_skill_is_skipped_not_fatal_matching_list() {
        let (_tmp, root) = root();
        save(&global(&root), "good", &fm("fine")).unwrap();
        save(&global(&root), "bad", &fm("x")).unwrap();
        fs::write(global(&root).join("bad").join(SKILL_FILE), [0xff, 0xfe, 0x00]).unwrap();

        let views = staged(&root, "ws-1", &[], false, &[]).unwrap();
        let skills = PathBuf::from(&views.dir);
        assert!(skills.join("good").exists());
        assert!(!skills.join("bad").exists());
        // list() treats the same file the same way — the two views agree.
        let listed = list(&root, &[]).unwrap();
        let names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["good"]);
    }

    #[test]
    fn copy_skips_write_atomics_transient_sibling() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("x")).unwrap();
        fs::write(global(&root).join("review").join("SKILL.md.tmp"), "torn").unwrap();

        let views = staged(&root, "ws-1", &[], false, &[]).unwrap();
        let skill = PathBuf::from(&views.dir).join("review");
        assert!(skill.join(SKILL_FILE).exists());
        assert!(!skill.join("SKILL.md.tmp").exists());
    }

    #[test]
    fn other_workspaces_skills_stay_out_of_a_staging() {
        let (_tmp, root) = root();
        save(&ws(&root, "ws-1"), "mine", &fm("x")).unwrap();
        save(&ws(&root, "ws-2"), "theirs", &fm("x")).unwrap();

        let views = staged(&root, "ws-1", &[], false, &[]).unwrap();
        let skills = PathBuf::from(&views.dir);
        assert!(skills.join("mine").exists());
        assert!(!skills.join("theirs").exists());
    }

    #[test]
    fn pruning_views_drops_dead_workspaces_and_spares_live_ones_and_the_library() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("x")).unwrap();
        save(&ws(&root, "ws-dead"), "gone", &fm("x")).unwrap();
        staged(&root, "ws-live", &[], false, &[]).unwrap();
        staged(&root, "ws-dead", &[], false, &[]).unwrap();
        // A crash leftover of a dead workspace's build.
        fs::create_dir_all(root.join("staging").join(".tmp-ws-dead")).unwrap();

        prune_views(&root, &["ws-live".into()]).unwrap();

        assert!(root.join("staging").join("ws-live").exists());
        assert!(!root.join("staging").join("ws-dead").exists());
        assert!(!root.join("staging").join(".tmp-ws-dead").exists());
        // The library — user content, dead workspace or not — is untouched.
        assert!(ws(&root, "ws-dead").join("gone").join(SKILL_FILE).exists());
    }

    // ---- the bundled tier's integration gates ----

    fn tier_skill(name: &'static str, gated: bool) -> BundledSkill {
        BundledSkill {
            name,
            content: "---\ndescription: static tier content\n---\nbody\n",
            gate: gated.then_some(GateKey::Artifacts),
        }
    }

    #[test]
    fn a_gated_tier_stages_only_while_claimed_and_never_shadows_the_library() {
        let (_tmp, root) = root();
        save(&global(&root), "alpha", &fm("alpha body")).unwrap();
        // Same-name day-one case: a user skill AND the bundled one.
        save(&global(&root), "bundled-one", &fm("user shadows this")).unwrap();
        let tier = [tier_skill("bundled-one", true), tier_skill("only-tier", true)];

        // CLAIMED: the tier materializes; the same-name library row WINS
        // (the merge order — tier first, library retains over it).
        let views = staged(&root, "ws-1", &tier, true, &[]).unwrap();
        let shadowed =
            fs::read_to_string(Path::new(&views.dir).join("bundled-one").join(SKILL_FILE)).unwrap();
        assert!(shadowed.contains("user shadows this"), "library wins: {shadowed}");
        assert!(
            Path::new(&views.dir).join("only-tier").join(SKILL_FILE).exists(),
            "the tier materializes while claimed"
        );

        // UNCLAIMED: the gated tier is absent entirely — no advice for tools
        // that are off.
        let views_off = staged(&root, "ws-1", &tier, false, &[]).unwrap();
        assert!(
            !Path::new(&views_off.dir).join("only-tier").exists(),
            "gated tier absent while unclaimed"
        );
        // The user's library skill still stages (the tier's gate is not
        // the library's).
        assert!(Path::new(&views_off.dir).join("alpha").join(SKILL_FILE).exists());
    }

    #[test]
    fn an_ungated_tier_stages_without_the_claim() {
        let (_tmp, root) = root();
        let tier = [tier_skill("always", false)];
        let views = staged(&root, "ws-1", &tier, false, &[]).unwrap();
        assert!(Path::new(&views.dir).join("always").join(SKILL_FILE).exists());
    }

    #[test]
    fn an_empty_library_with_a_claimed_tier_still_stages() {
        // "Is there anything to stage" counts the GATED tier — an empty
        // library with a claimed tier still hands it out.
        let (_tmp, root) = root();
        let tier = [tier_skill("solo", true)];
        let views = staged(&root, "ws-1", &tier, true, &[]).unwrap();
        assert!(
            Path::new(&views.dir).join("solo").join(SKILL_FILE).exists(),
            "claimed tier alone keeps the staging"
        );

        // And the flip side: empty library + UNCLAIMED tier = nothing.
        assert!(staged(&root, "ws-1", &tier, false, &[]).is_none());
    }

    // ---- the collection guard's own gates ----
    // The incident, pinned: a library file with no usable description
    // must not stage ANYWHERE, and must not shadow the tier's valid
    // same-name skill. WHICH rows have none is the host's codec's
    // judgement, handed over as `excluded`; what this side owns is
    // skipping them before the merge.

    fn excluded(scope: &str, ws_id: Option<&str>, name: &str) -> ExcludedSource {
        ExcludedSource {
            scope: scope.to_string(),
            ws_id: ws_id.map(str::to_string),
            name: name.to_string(),
        }
    }

    #[test]
    fn an_excluded_library_row_is_skipped_and_the_tier_stages_under_the_name() {
        // The residue case VERBATIM: garbage global 'artifacts' beside the
        // valid bundled one. Collection-side skipping means the garbage is
        // never gathered — the bundled skill stages; a materialization-side
        // skip would have retained the garbage over the tier first, leaving
        // BOTH dead.
        let (_tmp, root) = root();
        fs::create_dir_all(global(&root).join("artifacts")).unwrap();
        fs::write(global(&root).join("artifacts").join(SKILL_FILE), "user's own copy").unwrap();
        let tier = [tier_skill("artifacts", true)];

        let views = staged(&root, "ws-1", &tier, true, &[excluded("global", None, "artifacts")]).unwrap();
        let staged_text =
            fs::read_to_string(Path::new(&views.dir).join("artifacts").join(SKILL_FILE)).unwrap();
        assert!(
            staged_text.contains("static tier content"),
            "the bundled skill stages under the shadowed name: {staged_text}"
        );
        // The text handed to plugins is the same winning skill.
        assert_eq!(views.skills[0].content, staged_text);
    }

    #[test]
    fn an_excluded_bundled_entry_is_skipped_not_staged() {
        // Symmetry: first-party content CAN ship broken (a bad include!
        // edit) — the guard holds both arms. The host's bundledContent
        // suite keeps this arm theoretical by failing at test time.
        let (_tmp, root) = root();
        let tier = [
            BundledSkill { name: "broken", content: "no frontmatter at all", gate: None },
            tier_skill("whole", false),
        ];
        let views = staged(&root, "ws-1", &tier, false, &[excluded("bundled", None, "broken")]).unwrap();
        let skills = Path::new(&views.dir);
        assert!(!skills.join("broken").exists(), "broken tier row skipped");
        assert!(skills.join("whole").exists(), "valid neighbor still stages");
    }

    #[test]
    fn an_excluded_workspace_row_falls_back_to_the_global_one_and_names_only_its_scope() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("global review")).unwrap();
        save(&ws(&root, "ws-1"), "review", &fm("ws review")).unwrap();
        save(&global(&root), "other", &fm("other")).unwrap();
        let excluded_rows = [
            excluded("workspace", Some("ws-1"), "review"),
            // Another workspace's row of the same name says nothing here,
            // and a global exclusion of a different name touches nothing.
            excluded("workspace", Some("ws-2"), "other"),
        ];
        let views = staged(&root, "ws-1", &[], false, &excluded_rows).unwrap();
        let review = fs::read_to_string(Path::new(&views.dir).join("review").join(SKILL_FILE)).unwrap();
        assert!(review.contains("global review"), "the global row stages: {review}");
        assert!(Path::new(&views.dir).join("other").exists());
    }

    #[test]
    fn the_staging_hands_out_each_skill_as_text_by_name_beside_the_bare_view() {
        let (_tmp, root) = root();
        save(&global(&root), "zeta", &fm("last")).unwrap();
        save(&global(&root), "alpha", &fm("first")).unwrap();
        let tier = [tier_skill("middle", false)];
        let views = staged(&root, "ws-1", &tier, false, &[]).unwrap();
        let names: Vec<&str> = views.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "middle", "zeta"]);
        for skill in &views.skills {
            let on_disk = fs::read_to_string(Path::new(&views.dir).join(&skill.name).join(SKILL_FILE)).unwrap();
            assert_eq!(skill.content, on_disk, "{}: the text is the staged bytes", skill.name);
        }
    }

    #[test]
    fn the_list_still_shows_a_row_the_guard_skipped() {
        // The divergence is DELIBERATE and pinned so nobody "fixes" it:
        // list = what is on disk (fixable in the editor), staging = what is
        // handed out. A hidden broken row is unfixable.
        let (_tmp, root) = root();
        fs::create_dir_all(global(&root).join("broken")).unwrap();
        fs::write(global(&root).join("broken").join(SKILL_FILE), "no frontmatter").unwrap();
        save(&global(&root), "fine", &fm("fine body")).unwrap();

        let listed = list(&root, &[]).unwrap();
        let mut names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["broken", "fine"]);
    }

    #[test]
    fn a_ws_library_skill_shadows_the_tier_in_its_workspace() {
        // The full precedence: library-ws > library-global > bundled. Here
        // the ws row must beat the bundled one (the tier enters first, ws
        // retains last).
        let (_tmp, root) = root();
        save(&ws(&root, "ws-1"), "only-tier", &fm("ws wins")).unwrap();
        let tier = [tier_skill("only-tier", true)];
        let views = staged(&root, "ws-1", &tier, true, &[]).unwrap();
        let staged_text =
            fs::read_to_string(Path::new(&views.dir).join("only-tier").join(SKILL_FILE)).unwrap();
        assert!(staged_text.contains("ws wins"), "the ws library row wins: {staged_text}");
    }
}
