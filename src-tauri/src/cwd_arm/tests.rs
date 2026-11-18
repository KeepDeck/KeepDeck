//! The engine end to end, on real directories and a real git.

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use super::lifecycle;
use super::registry::{manifest, Hidden, Landing, Ledger, Place, Receipt, What};
use super::{disarm, prune, retire_historical_link, ArmRefusal, CwdArm, CwdArmReport, CAPS};
use crate::fs_beneath as fsb;

struct Scratch {
    _tmp: tempfile::TempDir,
    base: PathBuf,
    home: PathBuf,
    root: PathBuf,
    cwd: PathBuf,
}

fn scratch() -> Scratch {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let cwd = base.join("repo");
    fs::create_dir_all(&cwd).unwrap();
    Scratch { root: home.join("cwd-arms"), home, cwd, base, _tmp: tmp }
}

impl Scratch {
    /// The workspace's skills staging the plan hands out, made.
    fn skills(&self, ws: &str) -> PathBuf {
        let skills = self.home.join("skills/staging").join(ws).join("skills");
        fs::create_dir_all(&skills).unwrap();
        skills
    }
    /// One skill in it, made.
    fn skill(&self, ws: &str, name: &str) -> PathBuf {
        let skill = self.skills(ws).join(name);
        fs::create_dir_all(&skill).unwrap();
        skill
    }
    fn arm_in(&self, cwd: &Path, plugin: &str, ws: &str, arms: &[CwdArm]) -> CwdArmReport {
        self.pass(cwd, plugin, ws, arms).0
    }
    /// One pass, with what it cost.
    fn pass(&self, cwd: &Path, plugin: &str, ws: &str, arms: &[CwdArm]) -> (CwdArmReport, lifecycle::Stats) {
        let own = self.home.join("plugin-workspaces").join(plugin).join(ws);
        fs::create_dir_all(&own).unwrap();
        let allowed = vec![own, self.skills(ws)];
        lifecycle::arm(&self.root, &self.home, plugin, ws, &cwd.to_string_lossy(), arms, &allowed)
    }
    fn arm(&self, plugin: &str, ws: &str, arms: &[CwdArm]) -> CwdArmReport {
        self.arm_in(&self.cwd, plugin, ws, arms)
    }
    fn disarm(&self, cwd: &Path) -> std::io::Result<Vec<String>> {
        disarm(&self.root, &self.home, &[cwd.to_string_lossy().into_owned()], &[])
    }
    fn places(&self, ws: &str) -> Vec<Place> {
        Ledger::read(&self.root).unwrap().of(ws)
    }
    fn paths(&self, ws: &str) -> Vec<String> {
        self.places(ws).into_iter().filter(|p| !matches!(p.what, What::Dir { .. })).map(|p| p.path).collect()
    }
}

fn file(path: &str, content: &str) -> CwdArm {
    CwdArm::File { path: path.into(), content: content.into() }
}

fn link(path: &str, target: &Path) -> CwdArm {
    CwdArm::Symlink { path: path.into(), target: target.to_string_lossy().into_owned() }
}

fn refused(report: &CwdArmReport, path: &str) -> String {
    report.refused.iter().find(|r| r.path == path).map(|r| r.reason.clone()).unwrap_or_default()
}

fn lock(dir: &Path, locked: bool) {
    fs::set_permissions(dir, fs::Permissions::from_mode(if locked { 0o555 } else { 0o755 })).unwrap();
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// A real repo at `<base>/main` with one commit; its worktrees are made with
/// [`worktree`].
fn repo(s: &Scratch) -> PathBuf {
    let main = s.base.join("main");
    fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"]);
    git(&main, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]);
    main
}

fn worktree(main: &Path, name: &str) -> PathBuf {
    let wt = main.parent().unwrap().join(name);
    git(main, &["worktree", "add", "-q", "-b", name, wt.to_str().unwrap()]);
    fs::canonicalize(wt).unwrap()
}

/// The patterns of `main`'s exclude file, comments left out.
fn excluded(main: &Path) -> Vec<String> {
    let text = fs::read_to_string(main.join(".git/info/exclude")).unwrap_or_default();
    text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()).map(String::from).collect()
}

// ---- files: planted, rewritten, and never the user's ----

#[test]
fn plants_a_file_and_rewrites_it_next_time() {
    let s = scratch();
    let report = s.arm("p.filer", "ws-1", &[file(".conf/mcp.json", "{}")]);
    assert_eq!(report.armed, vec![".conf/mcp.json"]);
    assert_eq!(fs::read_to_string(s.cwd.join(".conf/mcp.json")).unwrap(), "{}");
    let again = s.arm("p.filer", "ws-1", &[file(".conf/mcp.json", "{\"a\":1}")]);
    assert!(again.refused.is_empty(), "{:?}", again.refused);
    assert_eq!(fs::read_to_string(s.cwd.join(".conf/mcp.json")).unwrap(), "{\"a\":1}");
    assert!(!s.cwd.join(".conf/.keepdeck-managed").exists(), "no marker: the receipt is the proof");
}

#[test]
fn a_file_of_the_users_is_never_written_over_nor_taken_back() {
    let s = scratch();
    fs::create_dir_all(s.cwd.join(".conf")).unwrap();
    fs::write(s.cwd.join(".conf/mcp.json"), "theirs").unwrap();
    let report = s.arm("p.filer", "ws-1", &[file(".conf/mcp.json", "ours")]);
    assert_eq!(refused(&report, ".conf/mcp.json"), ".conf/mcp.json is your own — nothing was planted");
    s.disarm(&s.cwd).unwrap();
    assert_eq!(fs::read_to_string(s.cwd.join(".conf/mcp.json")).unwrap(), "theirs");
}

#[test]
fn a_prepared_file_never_authorizes_taking_back_what_stands_after_a_crash() {
    // 761-P1a: recorded, crashed before it was published; a checkout then
    // put the very same bytes there. It is not the file KeepDeck staged.
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".conf/other", "x")]);
    let dir = fsb::open_dir(&s.cwd.join(".conf")).unwrap();
    let staged = fsb::stage_at(&dir, &fsb::temporary_beside("mcp.json".as_ref()), b"ours", 0o644).unwrap();
    let receipt = Receipt {
        state: Landing::Prepared,
        identity: staged.identity.unwrap(),
        digest: super::proof::digest(b"ours"),
        previous: None,
    };
    let mut places = s.places("ws-1");
    places.push(place(&s.cwd, "p.filer", ".conf/mcp.json", What::File { receipt: Some(receipt) }));
    places.push(reserved(&s.cwd, &staged));
    Ledger::read(&s.root).unwrap().write("ws-1", places).unwrap();
    fs::write(s.cwd.join(".conf/mcp.json"), "ours").unwrap();

    s.disarm(&s.cwd).unwrap();
    assert_eq!(fs::read_to_string(s.cwd.join(".conf/mcp.json")).unwrap(), "ours", "never ours to remove");
    assert!(fs::symlink_metadata(s.cwd.join(".conf").join(&staged.name)).is_err(), "the staged temporary went");
}

#[test]
fn a_file_published_before_a_crash_is_recognized_and_taken_back() {
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".conf/other", "x")]);
    let dir = fsb::open_dir(&s.cwd.join(".conf")).unwrap();
    let staged = fsb::stage_at(&dir, &fsb::temporary_beside("mcp.json".as_ref()), b"ours", 0o644).unwrap();
    let receipt = Receipt {
        state: Landing::Prepared,
        identity: staged.identity.unwrap(),
        digest: super::proof::digest(b"ours"),
        previous: None,
    };
    let mut places = s.places("ws-1");
    places.push(place(&s.cwd, "p.filer", ".conf/mcp.json", What::File { receipt: Some(receipt) }));
    places.push(reserved(&s.cwd, &staged));
    Ledger::read(&s.root).unwrap().write("ws-1", places).unwrap();
    fsb::publish_at(&dir, &staged.name, "mcp.json".as_ref(), fsb::Publish::Exclusive).unwrap();

    s.disarm(&s.cwd).unwrap();
    assert!(!s.cwd.join(".conf").exists(), "the landed file, and the folder made for it, went");
}

#[test]
fn a_crash_before_a_rewrite_was_published_keeps_the_file_it_was_replacing() {
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".conf/mcp.json", "old")]);
    let mut places = s.places("ws-1");
    let at = places.iter().position(|p| p.path == ".conf/mcp.json").unwrap();
    let What::File { receipt: Some(old) } = places[at].what.clone() else { panic!() };
    let dir = fsb::open_dir(&s.cwd.join(".conf")).unwrap();
    let staged = fsb::stage_at(&dir, &fsb::temporary_beside("mcp.json".as_ref()), b"new", 0o644).unwrap();
    let previous = super::registry::Landed { identity: old.identity, digest: old.digest };
    places[at].what = What::File {
        receipt: Some(Receipt {
            state: Landing::Prepared,
            identity: staged.identity.unwrap(),
            digest: super::proof::digest(b"new"),
            previous: Some(Box::new(previous)),
        }),
    };
    places.push(reserved(&s.cwd, &staged));
    Ledger::read(&s.root).unwrap().write("ws-1", places).unwrap();

    let report = s.arm("p.filer", "ws-1", &[file(".conf/mcp.json", "newer")]);
    assert!(report.refused.is_empty(), "{:?}", report.refused);
    assert_eq!(fs::read_to_string(s.cwd.join(".conf/mcp.json")).unwrap(), "newer");
    s.disarm(&s.cwd).unwrap();
    assert!(!s.cwd.join(".conf").exists());
}

#[test]
fn our_file_replaced_by_the_same_bytes_is_someone_elses() {
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".conf/mcp.json", "same")]);
    fs::remove_file(s.cwd.join(".conf/mcp.json")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    fs::write(s.cwd.join(".conf/mcp.json"), "same").unwrap();
    let report = s.arm("p.filer", "ws-1", &[file(".conf/mcp.json", "different")]);
    assert_eq!(refused(&report, ".conf/mcp.json"), ".conf/mcp.json is your own — nothing was planted");
    s.disarm(&s.cwd).unwrap();
    assert_eq!(fs::read_to_string(s.cwd.join(".conf/mcp.json")).unwrap(), "same");
}

#[test]
fn a_file_an_older_build_recorded_without_a_receipt_is_never_changed() {
    let s = scratch();
    fs::create_dir_all(s.cwd.join(".kimi-code")).unwrap();
    fs::write(s.cwd.join(".kimi-code/mcp.json"), "old").unwrap();
    fs::write(s.cwd.join(".kimi-code/.keepdeck-managed"), "").unwrap();
    let older = place(&s.cwd, "keepdeck.kimi", ".kimi-code/mcp.json", What::File { receipt: None });
    Ledger::read(&s.root).unwrap().write("ws-1", vec![Place { hidden: Hidden::FirstSegment, ..older }]).unwrap();
    let report = s.arm("keepdeck.kimi", "ws-1", &[file(".kimi-code/mcp.json", "new")]);
    assert!(refused(&report, ".kimi-code/mcp.json").contains("older KeepDeck record that cannot be verified"));
    assert_eq!(fs::read_to_string(s.cwd.join(".kimi-code/mcp.json")).unwrap(), "old");
    s.disarm(&s.cwd).unwrap();
    assert_eq!(fs::read_to_string(s.cwd.join(".kimi-code/mcp.json")).unwrap(), "old");
}

/// The reservation the engine records for `staged`, beside `.conf/mcp.json`,
/// before it is made (no repo: no line to owe).
fn reserved(cwd: &Path, staged: &fsb::Staged) -> Place {
    place(cwd, "p.filer", &format!(".conf/{}", staged.name.to_string_lossy()), What::Temp { made: staged.identity })
}

fn place(cwd: &Path, plugin: &str, path: &str, what: What) -> Place {
    Place {
        cwd: cwd.to_string_lossy().into_owned(),
        plugin: plugin.into(),
        path: path.into(),
        what,
        hidden: Hidden::Exact,
        owed: None,
    }
}

// ---- links: ours by where they point ----

#[test]
fn a_link_points_only_into_the_plugins_own_directory_or_this_plans_skills() {
    let s = scratch();
    let skills = s.skills("ws-1");
    assert_eq!(s.arm("p.linker", "ws-1", &[link(".l", &skills)]).armed, vec![".l"]);
    assert_eq!(fs::read_link(s.cwd.join(".l")).unwrap(), skills);
    let elsewhere = s.base.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    let out = s.arm("p.linker", "ws-1", &[link(".l", &elsewhere)]);
    assert_eq!(refused(&out, ".l"), ".l would point outside what this agent may link to");
    assert_eq!(fs::read_link(s.cwd.join(".l")).unwrap(), skills, "still declared: what stood keeps standing");
    assert!(s.arm("p.linker", "ws-1", &[]).refused.is_empty());
    assert!(fs::symlink_metadata(s.cwd.join(".l")).is_err(), "no longer declared: taken back");
}

#[test]
fn a_link_is_planted_only_where_it_would_later_be_recognized_as_ours() {
    // A plan's skills folder outside this workspace's own directories: a link
    // there could be planted, but never told apart from the user's after.
    let s = scratch();
    let outside = s.base.join("outside-skills");
    fs::create_dir_all(&outside).unwrap();
    let cwd = s.cwd.to_string_lossy();
    let (report, _) =
        lifecycle::arm(&s.root, &s.home, "p.linker", "ws-1", &cwd, &[link(".l", &outside)], std::slice::from_ref(&outside));
    assert_eq!(refused(&report, ".l"), ".l would point outside what this agent may link to");
    assert!(fs::symlink_metadata(s.cwd.join(".l")).is_err());
}

#[test]
fn a_link_cannot_leave_its_directory_by_dot_dot_by_a_link_or_by_not_existing_yet() {
    let s = scratch();
    let skills = s.skills("ws-1");
    let other = s.base.join("other");
    fs::create_dir_all(&other).unwrap();
    symlink(&other, skills.join("escape")).unwrap();
    for target in
        [skills.join("../../../other/x"), skills.join("../skills"), skills.join("escape"), skills.join("later")]
    {
        let report = s.arm("p.linker", "ws-1", &[link(".l", &target)]);
        assert_eq!(report.refused.len(), 1, "{}", target.display());
        assert!(fs::symlink_metadata(s.cwd.join(".l")).is_err(), "{}", target.display());
    }
}

#[test]
fn a_link_is_made_to_the_real_location_of_its_target() {
    let s = scratch();
    let skills = s.skills("ws-1");
    let alias = s.base.join("alias");
    symlink(&skills, &alias).unwrap();
    assert!(s.arm("p.linker", "ws-1", &[link(".l", &alias)]).refused.is_empty());
    assert_eq!(fs::read_link(s.cwd.join(".l")).unwrap(), skills);
}

#[test]
fn a_link_not_into_our_directories_is_the_users_and_stays() {
    // The user's skill from their dotfiles, one dangling into nothing, a
    // repointed one of ours, another workspace's, another KeepDeck home's.
    let s = scratch();
    let review = s.skill("ws-1", "review");
    s.arm("p.linker", "ws-1", &[link(".agents/skills/review", &review)]);
    let dotfiles = s.base.join("dotfiles/review");
    fs::create_dir_all(&dotfiles).unwrap();
    fs::remove_file(s.cwd.join(".agents/skills/review")).unwrap();
    symlink(&dotfiles, s.cwd.join(".agents/skills/review")).unwrap();
    let theirs = [
        ("gone", s.base.join("gone")),
        ("ws2", s.skill("ws-2", "ws2")),
        ("dev", s.base.join("home-dev/skills/staging/ws-1/skills/dev")),
    ];
    for (name, target) in &theirs {
        symlink(target, s.cwd.join(".agents/skills").join(name)).unwrap();
    }
    let arms: Vec<CwdArm> = ["review", "gone", "ws2", "dev"]
        .iter()
        .map(|name| link(&format!(".agents/skills/{name}"), &s.skill("ws-1", name)))
        .collect();
    let report = s.arm("p.linker", "ws-1", &arms);
    assert!(report.armed.is_empty(), "{:?}", report.armed);
    assert_eq!(refused(&report, ".agents/skills/review"), ".agents/skills/review is your own — nothing was planted");
    s.disarm(&s.cwd).unwrap();
    assert_eq!(fs::read_link(s.cwd.join(".agents/skills/review")).unwrap(), dotfiles);
    for (name, target) in &theirs {
        assert_eq!(&fs::read_link(s.cwd.join(".agents/skills").join(name)).unwrap(), target);
    }
}

#[test]
fn a_link_already_pointing_where_ours_would_is_kept_and_taken_back_as_ours() {
    let s = scratch();
    let skills = s.skills("ws-1");
    symlink(&skills, s.cwd.join(".l")).unwrap();
    assert_eq!(s.arm("p.linker", "ws-1", &[link(".l", &skills)]).armed, vec![".l"]);
    s.disarm(&s.cwd).unwrap();
    assert!(fs::symlink_metadata(s.cwd.join(".l")).is_err());
}

#[test]
fn nothing_is_written_through_a_parent_that_is_a_file_or_a_link() {
    let s = scratch();
    let skills = s.skills("ws-1");
    fs::write(s.cwd.join(".agents"), "a file").unwrap();
    let report = s.arm("p.linker", "ws-1", &[link(".agents/skills/x", &skills)]);
    assert_eq!(refused(&report, ".agents/skills/x"), ".agents here is not a directory");
    fs::remove_file(s.cwd.join(".agents")).unwrap();
    let elsewhere = s.base.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    symlink(&elsewhere, s.cwd.join(".agents")).unwrap();
    let report = s.arm("p.linker", "ws-1", &[link(".agents/skills/x", &skills)]);
    assert_eq!(refused(&report, ".agents/skills/x"), ".agents here is not a directory");
    assert!(fs::read_dir(&elsewhere).unwrap().next().is_none(), "nothing landed in their target");
}

#[test]
fn nothing_is_taken_back_through_a_folder_that_became_a_link() {
    let s = scratch();
    let one = s.skill("ws-1", "one");
    s.arm("p.linker", "ws-1", &[link(".agents/skills/one", &one)]);
    let theirs = s.base.join("dotfiles/skills");
    fs::create_dir_all(&theirs).unwrap();
    symlink(&one, theirs.join("one")).unwrap();
    fs::remove_dir_all(s.cwd.join(".agents/skills")).unwrap();
    symlink(&theirs, s.cwd.join(".agents/skills")).unwrap();
    s.disarm(&s.cwd).unwrap();
    assert_eq!(fs::read_link(theirs.join("one")).unwrap(), one);
}

#[test]
fn a_directory_of_the_users_stays_as_it_is() {
    let s = scratch();
    fs::create_dir_all(s.cwd.join(".agents/skills/theirs")).unwrap();
    let report = s.arm("p.linker", "ws-1", &[link(".agents/skills", &s.skills("ws-1"))]);
    assert_eq!(refused(&report, ".agents/skills"), ".agents/skills is your own — nothing was planted");
    s.disarm(&s.cwd).unwrap();
    assert!(s.cwd.join(".agents/skills/theirs").is_dir());
}

// ---- the older whole-folder link, and other workspaces ----

/// What older builds left: codex's link to the whole skills folder of `ws`,
/// recorded without a way of hiding, the whole first segment hidden.
fn older_folder_link(s: &Scratch, ws: &str, cwd: &Path) {
    fs::create_dir_all(cwd.join(".agents")).unwrap();
    symlink(s.skills(ws), cwd.join(".agents/skills")).unwrap();
    let mut ledger = Ledger::read(&s.root).unwrap();
    let mut places = ledger.of(ws);
    places.push(Place {
        cwd: fs::canonicalize(cwd).unwrap().to_string_lossy().into_owned(),
        plugin: "keepdeck.codex".into(),
        path: ".agents/skills".into(),
        what: What::Symlink { target: Some(s.skills(ws).to_string_lossy().into_owned()) },
        hidden: Hidden::FirstSegment,
        owed: None,
    });
    ledger.write(ws, places).unwrap();
    if let Ok(Some(repo)) = keepdeck_git::exclude::owning_repo(cwd) {
        keepdeck_git::exclude::ensure_line(&repo.common_dir, "/.agents/").unwrap();
    }
}

#[test]
fn an_older_folder_link_becomes_a_link_per_skill_in_one_launch_for_every_workspace() {
    let s = scratch();
    let main = repo(&s);
    let (one, two) = (s.skill("ws-1", "one"), s.skill("ws-1", "two"));
    // The old link stands for ws-2, the workspace that launched first.
    older_folder_link(&s, "ws-2", &main);
    let set = [link(".agents/skills/one", &one), link(".agents/skills/two", &two)];
    let report = s.arm_in(&main, "keepdeck.codex", "ws-1", &set);
    assert!(report.refused.is_empty(), "it gives way once, for every skill inside: {:?}", report.refused);
    assert!(fs::symlink_metadata(main.join(".agents/skills")).unwrap().is_dir());
    assert_eq!(fs::read_link(main.join(".agents/skills/one")).unwrap(), one);
    assert_eq!(fs::read_link(main.join(".agents/skills/two")).unwrap(), two);
    assert!(s.paths("ws-2").is_empty(), "ws-2's record of the old link went with it");
    assert_eq!(excluded(&main), ["/.agents/skills/one", "/.agents/skills/two"]);
}

#[test]
fn only_codex_may_have_its_older_folder_link_give_way() {
    let s = scratch();
    older_folder_link(&s, "ws-1", &s.cwd);
    let report = s.arm("p.other", "ws-1", &[link(".agents/skills/x", &s.skill("ws-1", "x"))]);
    assert_eq!(refused(&report, ".agents/skills/x"), ".agents/skills here is not a directory");
    assert_eq!(fs::read_link(s.cwd.join(".agents/skills")).unwrap(), s.skills("ws-1"));
}

#[test]
fn another_homes_folder_link_is_not_this_homes_to_clear() {
    let s = scratch();
    let foreign = s.base.join("home-dev/skills/staging/ws-1/skills");
    fs::create_dir_all(&foreign).unwrap();
    fs::create_dir_all(s.cwd.join(".agents")).unwrap();
    symlink(&foreign, s.cwd.join(".agents/skills")).unwrap();
    let report = s.arm("keepdeck.codex", "ws-1", &[link(".agents/skills/one", &s.skill("ws-1", "one"))]);
    assert_eq!(refused(&report, ".agents/skills/one"), ".agents/skills here is not a directory");
    assert_eq!(fs::read_link(s.cwd.join(".agents/skills")).unwrap(), foreign);
}

#[test]
fn two_workspaces_in_one_folder_each_plant_and_take_back_their_own() {
    let s = scratch();
    let a = s.skill("ws-1", "a");
    let b = s.skill("ws-2", "b");
    assert!(s.arm("p.linker", "ws-1", &[link(".agents/skills/a", &a)]).refused.is_empty());
    assert!(s.arm("p.linker", "ws-2", &[link(".agents/skills/b", &b)]).refused.is_empty());
    let same =
        s.arm("p.linker", "ws-2", &[link(".agents/skills/b", &b), link(".agents/skills/a", &s.skill("ws-2", "a"))]);
    assert_eq!(refused(&same, ".agents/skills/a"), ".agents/skills/a is your own — nothing was planted");
    prune(&s.root, &s.home, &["ws-2".into()]).unwrap();
    assert!(fs::symlink_metadata(s.cwd.join(".agents/skills/a")).is_err(), "ws-1's own went with it");
    assert_eq!(fs::read_link(s.cwd.join(".agents/skills/b")).unwrap(), b, "ws-2's stays");
    let again =
        s.arm("p.linker", "ws-2", &[link(".agents/skills/b", &b), link(".agents/skills/a", &s.skill("ws-2", "a"))]);
    assert!(again.refused.is_empty(), "{:?}", again.refused);
}

// ---- one path, one plugin; what a set may declare ----

#[test]
fn one_path_belongs_to_one_plugin_and_two_spellings_are_one_path() {
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".x/mcp.json", "a")]);
    let other = s.arm("p.other", "ws-2", &[file(".x/MCP.json", "b")]);
    assert_eq!(refused(&other, ".x/MCP.json"), ".x/MCP.json is planted here by another agent");
    assert_eq!(fs::read_to_string(s.cwd.join(".x/mcp.json")).unwrap(), "a");
    let twice = s.arm("p.filer", "ws-1", &[file(".y/a", "1"), file(".y/A", "2"), file(".y//./a", "3")]);
    assert_eq!(refused(&twice, ".y/A"), ".y/A is declared twice");
    assert_eq!(refused(&twice, ".y//./a"), ".y//./a is declared twice");
    let spelled = s.arm("p.filer", "ws-1", &[file(".z//b", "1")]);
    assert!(spelled.refused.is_empty(), "{:?}", spelled.refused);
    assert_eq!(s.paths("ws-1"), [".z/b"], "recorded in its one spelling");
    let line = s.arm("p.filer", "ws-1", &[file(".n/a\nb", "1"), file(".n/c\rd", "1")]);
    assert_eq!(refused(&line, ".n/a\nb"), ".n/a\nb has a name git cannot be told to ignore");
    assert_eq!(refused(&line, ".n/c\rd"), ".n/c\rd has a name git cannot be told to ignore");
}

#[test]
fn a_set_declaring_one_path_inside_another_plants_neither() {
    let s = scratch();
    let skills = s.skills("ws-1");
    let report = s.arm("p.linker", "ws-1", &[link(".a", &skills), link(".a/b", &skills)]);
    assert_eq!(refused(&report, ".a"), ".a holds .a/b, declared too");
    assert_eq!(refused(&report, ".a/b"), ".a/b lies inside .a, declared too");
    assert!(fs::symlink_metadata(s.cwd.join(".a")).is_err());
}

#[test]
fn a_path_that_leaves_the_directory_is_refused_and_a_gone_directory_plants_nothing() {
    let s = scratch();
    for path in ["../escape", "/abs", "", "a/../../b"] {
        assert_eq!(s.arm("p.filer", "ws-1", &[file(path, "x")]).refused.len(), 1, "{path:?}");
    }
    assert!(!s.base.join("escape").exists());
    fs::remove_dir_all(&s.cwd).unwrap();
    let report = s.arm("p.filer", "ws-1", &[file(".k/c", "x")]);
    assert_eq!(report.refused[0].reason, "this directory no longer exists");
    assert!(!s.cwd.exists());
}

#[test]
fn past_the_entries_cap_each_further_entry_is_refused_and_the_rest_planted() {
    let s = scratch();
    let skills = s.skills("ws-1");
    let many: Vec<CwdArm> = (0..=CAPS.entries_max).map(|i| link(&format!(".s/s{i:04}"), &skills)).collect();
    let report = s.arm("p.linker", "ws-1", &many);
    assert_eq!(report.armed.len(), CAPS.entries_max);
    let last = format!(".s/s{:04}", CAPS.entries_max);
    let reason = format!("past the {} entries KeepDeck plants in one folder", CAPS.entries_max);
    assert_eq!(report.refused, vec![ArmRefusal { path: last, reason }]);
}

#[test]
fn more_content_than_keepdeck_plants_is_refused_whole_and_one_oversized_entry_alone() {
    let s = scratch();
    let quarter = "x".repeat(CAPS.total_content_max_bytes / 4);
    let many: Vec<CwdArm> = (0..5).map(|i| file(&format!(".k/{i}"), &quarter)).collect();
    assert_eq!(s.arm("p.filer", "ws-1", &many).refused.len(), 5);
    assert!(!s.cwd.join(".k").exists());
    let big = "x".repeat(CAPS.content_max_bytes + 1);
    let report = s.arm("p.filer", "ws-1", &[file(".k/big", &big), file(".k/small", "x")]);
    assert_eq!(refused(&report, ".k/big"), ".k/big is larger than KeepDeck plants");
    assert_eq!(report.armed, vec![".k/small"]);
}

// ---- the set is complete; folders made are taken back ----

#[test]
fn what_is_no_longer_declared_is_taken_back_with_the_folders_made_for_it() {
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".k/a", "1"), file(".k/b", "2")]);
    s.arm("p.filer", "ws-1", &[file(".k/a", "1")]);
    assert!(!s.cwd.join(".k/b").exists());
    let none = s.arm("p.filer", "ws-1", &[]);
    assert!(none.armed.is_empty() && none.refused.is_empty());
    assert!(!s.cwd.join(".k").exists(), "nothing of ours is left, not even the folder made for it");
    assert!(!manifest(&s.root, "ws-1").exists());
}

#[test]
fn a_folder_is_taken_back_only_while_it_is_the_one_made_and_empty() {
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".k/a", "1")]);
    fs::write(s.cwd.join(".k/theirs"), "x").unwrap();
    s.arm("p.filer", "ws-1", &[]);
    assert!(s.cwd.join(".k/theirs").exists(), "a folder holding something else stays");

    s.arm("p.filer", "ws-1", &[file(".m/a", "1")]);
    fs::remove_file(s.cwd.join(".m/a")).unwrap();
    fs::remove_dir(s.cwd.join(".m")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    fs::create_dir(s.cwd.join(".m")).unwrap();
    s.arm("p.filer", "ws-1", &[]);
    assert!(s.cwd.join(".m").is_dir(), "an empty folder made by someone else in its place stays");
}

#[test]
fn a_refused_planting_leaves_no_record_and_no_folder_behind() {
    let s = scratch();
    fs::create_dir_all(s.cwd.join(".k/c")).unwrap();
    let report = s.arm("p.filer", "ws-1", &[file(".k/c", "x")]);
    assert_eq!(refused(&report, ".k/c"), ".k/c is your own — nothing was planted");
    assert!(!manifest(&s.root, "ws-1").exists());
    assert!(s.cwd.join(".k/c").is_dir());
}

// ---- records: written first, kept when a change would not go ----

#[test]
fn nothing_is_planted_that_could_not_be_recorded_first() {
    let s = scratch();
    let skills = s.skills("ws-1");
    fs::create_dir_all(&s.root).unwrap();
    lock(&s.root, true);
    let report = s.arm("p.mixed", "ws-1", &[link(".l", &skills), file(".k/conf", "{}")]);
    lock(&s.root, false);
    assert!(report.armed.is_empty());
    assert_eq!(refused(&report, ".k/conf"), "KeepDeck's record of what it plants here could not be written");
    assert!(fs::symlink_metadata(s.cwd.join(".l")).is_err());
    assert!(!s.cwd.join(".k").exists(), "the folder made for it went too");
}

#[test]
fn a_pass_that_changes_nothing_writes_nothing() {
    let s = scratch();
    let main = repo(&s);
    let skills = s.skills("ws-1");
    let set = [link(".l", &skills), file(".k/conf", "{}")];
    s.arm_in(&main, "p.mixed", "ws-1", &set);
    lock(&s.root, true);
    lock(&main.join(".git/info"), true);
    let again = s.arm_in(&main, "p.mixed", "ws-1", &set);
    lock(&main.join(".git/info"), false);
    lock(&s.root, false);
    assert!(again.refused.is_empty(), "{:?}", again.refused);
    assert_eq!(again.armed, vec![".l", ".k/conf"]);
}

#[test]
fn a_take_back_that_would_not_go_stays_recorded_and_goes_on_a_later_pass() {
    let s = scratch();
    let skills = s.skills("ws-1");
    s.arm("p.mixed", "ws-1", &[file(".k/conf", "{}"), link(".agents/l", &skills)]);
    lock(&s.cwd.join(".k"), true);
    let err = s.disarm(&s.cwd).unwrap_err();
    lock(&s.cwd.join(".k"), false);
    assert!(err.to_string().contains(".k/conf"), "{err}");
    assert!(!s.cwd.join(".agents").exists(), "what went is forgotten");
    assert_eq!(s.paths("ws-1"), vec![".k/conf"]);
    assert_eq!(s.disarm(&s.cwd).unwrap(), vec![s.cwd.to_string_lossy().into_owned()]);
    assert!(!s.cwd.join(".k").exists());
    assert!(!manifest(&s.root, "ws-1").exists());
}

#[test]
fn while_a_record_will_not_read_nothing_standing_changes_and_new_places_are_still_planted() {
    let s = scratch();
    let skills = s.skills("ws-1");
    s.arm("p.mixed", "ws-1", &[link(".l", &skills), file(".k/conf", "a")]);
    fs::write(manifest(&s.root, "ws-9"), "not json").unwrap();
    let report = s.arm("p.mixed", "ws-1", &[file(".k/conf", "b"), link(".n", &skills)]);
    assert!(refused(&report, ".k/conf").contains("cannot change while another workspace's record will not read"));
    assert_eq!(fs::read_to_string(s.cwd.join(".k/conf")).unwrap(), "a");
    assert!(fs::symlink_metadata(s.cwd.join(".l")).is_ok(), "nothing taken back: ws-9 might claim it");
    assert_eq!(fs::read_link(s.cwd.join(".n")).unwrap(), skills, "an empty name may still be filled");
    assert!(disarm(&s.root, &s.home, &[s.cwd.to_string_lossy().into_owned()], &[]).is_err());
    // Once ws-9 is gone for good, its record is set aside, never deleted.
    prune(&s.root, &s.home, &["ws-1".into()]).unwrap();
    assert_eq!(fs::read_to_string(s.root.join("ws-9.json.unreadable")).unwrap(), "not json");
    assert!(s.arm("p.mixed", "ws-1", &[]).refused.is_empty());
    assert!(fs::symlink_metadata(s.cwd.join(".l")).is_err());
}

#[test]
fn disarm_leaves_a_root_a_live_workspace_still_is_however_it_is_spelled() {
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".conf/mcp.json", "{}")]);
    let alias = s.base.join("alias");
    symlink(&s.cwd, &alias).unwrap();
    let live = [alias.to_string_lossy().into_owned()];
    assert!(disarm(&s.root, &s.home, &[s.cwd.to_string_lossy().into_owned()], &live).unwrap().is_empty());
    assert!(s.cwd.join(".conf/mcp.json").exists());
    let dotted = format!("{}/../repo", s.cwd.display());
    assert_eq!(disarm(&s.root, &s.home, std::slice::from_ref(&dotted), &[]).unwrap(), vec![dotted]);
    assert!(!s.cwd.join(".conf").exists());
}

#[test]
fn an_older_builds_link_is_retired_by_the_engines_own_proof_and_its_folder_stays() {
    let s = scratch();
    fs::create_dir_all(s.cwd.join(".agents")).unwrap();
    symlink(s.skills("ws-1"), s.cwd.join(".agents/skills")).unwrap();
    retire_historical_link(&s.home, &s.cwd).unwrap();
    assert!(fs::symlink_metadata(s.cwd.join(".agents/skills")).is_err());
    assert!(s.cwd.join(".agents").is_dir(), "nothing proves the folder was theirs");
}

#[test]
fn an_older_builds_link_the_engine_records_or_cannot_prove_stays() {
    let s = scratch();
    // Recorded: the engine settles it itself.
    older_folder_link(&s, "ws-1", &s.cwd);
    retire_historical_link(&s.home, &s.cwd).unwrap();
    assert!(fs::symlink_metadata(s.cwd.join(".agents/skills")).is_ok());
    // Reached through a link on the way: nothing is taken through it.
    let elsewhere = s.base.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    symlink(s.skills("ws-1"), elsewhere.join("skills")).unwrap();
    let other = s.base.join("other");
    fs::create_dir_all(&other).unwrap();
    symlink(&elsewhere, other.join(".agents")).unwrap();
    retire_historical_link(&s.home, &other).unwrap();
    assert!(fs::symlink_metadata(elsewhere.join("skills")).is_ok());
    // While a record will not read, it may claim the place.
    fs::write(manifest(&s.root, "ws-9"), "not json").unwrap();
    let third = s.base.join("third");
    fs::create_dir_all(third.join(".agents")).unwrap();
    symlink(s.skills("ws-1"), third.join(".agents/skills")).unwrap();
    assert!(retire_historical_link(&s.home, &third).is_err());
    assert!(fs::symlink_metadata(third.join(".agents/skills")).is_ok());
}

// ---- git: blind to exactly what is planted ----

#[test]
fn git_is_blind_to_our_links_only_and_from_before_they_are_published() {
    let s = scratch();
    let main = repo(&s);
    fs::create_dir_all(main.join(".agents/skills/team")).unwrap();
    let ours = s.skill("ws-1", "ours");
    s.arm_in(&main, "p.linker", "ws-1", &[link(".agents/skills/ours", &ours)]);
    assert_eq!(excluded(&main), ["/.agents/skills/ours"]);
    s.arm_in(&main, "p.linker", "ws-1", &[]);
    assert!(excluded(&main).is_empty());
    assert!(main.join(".agents/skills/team").is_dir());
}

#[test]
fn a_line_that_cannot_be_added_first_plants_nothing() {
    let s = scratch();
    let main = repo(&s);
    lock(&main.join(".git/info"), true);
    let report = s.arm_in(&main, "p.linker", "ws-1", &[link(".agents/skills/x", &s.skill("ws-1", "x"))]);
    lock(&main.join(".git/info"), false);
    assert_eq!(refused(&report, ".agents/skills/x"), "this could not be kept from git — nothing was planted");
    assert!(!main.join(".agents").exists(), "neither the link nor the folders made for it");
}

#[test]
fn the_line_two_worktrees_of_one_repo_share_goes_with_the_last_planting() {
    let s = scratch();
    let main = repo(&s);
    let (one, two) = (worktree(&main, "one"), worktree(&main, "two"));
    let skills = s.skills("ws-1");
    for wt in [&one, &two] {
        s.arm_in(wt, "p.linker", "ws-1", &[link(".l", &skills)]);
    }
    s.disarm(&one).unwrap();
    assert_eq!(excluded(&main), ["/.l"], "the other still needs it");
    s.disarm(&two).unwrap();
    assert!(excluded(&main).is_empty());
}

#[test]
fn a_line_stays_while_anything_stands_at_its_entry_in_any_worktree() {
    // Another KeepDeck home planted there since — a link into its own plugin
    // directory, or a file — in this worktree or another: this ledger cannot
    // see its record, so the line it needs stays.
    let s = scratch();
    let main = repo(&s);
    let wt = worktree(&main, "wt");
    let skills = s.skills("ws-1");
    s.arm_in(&wt, "p.linker", "ws-1", &[link(".l", &skills), link(".m", &skills)]);
    symlink("/home-dev/plugin-workspaces/p/ws-1/x", main.join(".l")).unwrap();
    fs::write(main.join(".m"), "theirs").unwrap();
    s.disarm(&wt).unwrap();
    assert_eq!(excluded(&main), ["/.l", "/.m"]);
    assert!(s.places("ws-1").iter().all(|p| matches!(p.what, What::Line)), "each line stays owed");
    fs::remove_file(main.join(".l")).unwrap();
    fs::remove_file(main.join(".m")).unwrap();
    s.disarm(&wt).unwrap();
    assert!(excluded(&main).is_empty(), "nothing stands anywhere now");
    assert!(s.places("ws-1").is_empty());
}

#[test]
fn an_older_builds_whole_folder_line_goes_once_no_worktree_holds_its_link() {
    let s = scratch();
    let main = repo(&s);
    let wt = worktree(&main, "wt");
    older_folder_link(&s, "ws-1", &main);
    older_folder_link(&s, "ws-2", &wt);
    s.disarm(&main).unwrap();
    assert_eq!(excluded(&main), ["/.agents/"], "the other worktree's old link still needs it");
    fs::create_dir_all(main.join(".agents/mine")).unwrap();
    s.disarm(&wt).unwrap();
    assert!(excluded(&main).is_empty(), "what else stands under it is the user's, and visible");
}

#[test]
fn an_older_builds_file_line_stays_while_anything_stands_at_its_file() {
    let s = scratch();
    let main = repo(&s);
    fs::create_dir_all(main.join(".kimi-code")).unwrap();
    fs::write(main.join(".kimi-code/mcp.json"), "old").unwrap();
    let older = place(&main, "keepdeck.kimi", ".kimi-code/mcp.json", What::File { receipt: None });
    Ledger::read(&s.root).unwrap().write("ws-1", vec![Place { hidden: Hidden::FirstSegment, ..older }]).unwrap();
    keepdeck_git::exclude::ensure_line(&main.join(".git"), "/.kimi-code/").unwrap();
    s.disarm(&main).unwrap();
    assert_eq!(excluded(&main), ["/.kimi-code/"], "the file is left there, unproven, and stays hidden");
}

#[test]
fn links_per_skill_live_beside_a_projects_own_skills_and_yield_to_one_of_the_same_name() {
    let s = scratch();
    let main = repo(&s);
    for theirs in ["review", "deploy"] {
        fs::create_dir_all(main.join(".agents/skills").join(theirs)).unwrap();
        fs::write(main.join(".agents/skills").join(theirs).join("SKILL.md"), "theirs").unwrap();
    }
    let ours: Vec<CwdArm> =
        ["review", "triage"].iter().map(|n| link(&format!(".agents/skills/{n}"), &s.skill("ws-1", n))).collect();
    let report = s.arm_in(&main, "keepdeck.codex", "ws-1", &ours);
    assert_eq!(report.armed, vec![".agents/skills/triage"]);
    assert_eq!(refused(&report, ".agents/skills/review"), ".agents/skills/review is your own — nothing was planted");
    assert_eq!(excluded(&main), ["/.agents/skills/triage"]);
    s.disarm(&main).unwrap();
    assert!(fs::symlink_metadata(main.join(".agents/skills/triage")).is_err());
    for theirs in ["review", "deploy"] {
        assert_eq!(fs::read_to_string(main.join(".agents/skills").join(theirs).join("SKILL.md")).unwrap(), "theirs");
    }
}

// ---- what a pass changes, in what order, and what it costs ----

#[test]
fn a_rewrite_that_cannot_be_hidden_first_leaves_what_stood() {
    let s = scratch();
    let main = repo(&s);
    s.arm_in(&main, "p.filer", "ws-1", &[file(".k/conf", "a")]);
    let before = s.places("ws-1");
    lock(&main.join(".git/info"), true);
    let report = s.arm_in(&main, "p.filer", "ws-1", &[file(".k/conf", "b")]);
    lock(&main.join(".git/info"), false);
    assert_eq!(refused(&report, ".k/conf"), "this could not be kept from git — nothing was planted");
    assert_eq!(fs::read_to_string(main.join(".k/conf")).unwrap(), "a");
    assert_eq!(fs::read_dir(main.join(".k")).unwrap().count(), 1, "nothing staged beside it");
    let owed = |p: &Place| matches!(p.what, What::Line | What::Temp { .. });
    let standing: Vec<Place> = s.places("ws-1").into_iter().filter(|p| !owed(p)).collect();
    assert_eq!(standing, before);
    assert_eq!(excluded(&main), ["/.k/conf"]);
    // What the pass meant to do stays recorded until a later one lets it go.
    s.arm_in(&main, "p.filer", "ws-1", &[file(".k/conf", "a")]);
    assert_eq!(s.places("ws-1"), before);
    assert_eq!(excluded(&main), ["/.k/conf"]);
}

#[test]
fn a_file_planted_in_a_repo_leaves_git_blind_to_it_alone() {
    // Its temporary was hidden while it was staged, and let go once gone.
    let s = scratch();
    let main = repo(&s);
    s.arm_in(&main, "p.filer", "ws-1", &[file(".k/conf", "a")]);
    s.arm_in(&main, "p.filer", "ws-1", &[file(".k/conf", "b")]);
    assert_eq!(excluded(&main), ["/.k/conf"]);
    assert_eq!(s.places("ws-1").iter().filter(|p| matches!(p.what, What::Line | What::Temp { .. })).count(), 0);
}

#[test]
fn a_planting_that_cannot_be_read_now_stays_recorded_for_a_later_pass() {
    // Published before a crash, its folder unreadable at the next pass: the
    // record is what finds it again — it is never let go on an error.
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".conf/other", "x")]);
    let dir = fsb::open_dir(&s.cwd.join(".conf")).unwrap();
    let staged = fsb::stage_at(&dir, &fsb::temporary_beside("mcp.json".as_ref()), b"ours", 0o644).unwrap();
    let receipt = Receipt {
        state: Landing::Prepared,
        identity: staged.identity.unwrap(),
        digest: super::proof::digest(b"ours"),
        previous: None,
    };
    let mut places = s.places("ws-1");
    places.push(place(&s.cwd, "p.filer", ".conf/mcp.json", What::File { receipt: Some(receipt) }));
    Ledger::read(&s.root).unwrap().write("ws-1", places).unwrap();
    fsb::publish_at(&dir, &staged.name, "mcp.json".as_ref(), fsb::Publish::Exclusive).unwrap();
    fs::set_permissions(s.cwd.join(".conf"), fs::Permissions::from_mode(0o000)).unwrap();
    let err = s.disarm(&s.cwd);
    fs::set_permissions(s.cwd.join(".conf"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(err.is_err());
    assert!(s.paths("ws-1").contains(&".conf/mcp.json".to_string()));
    s.disarm(&s.cwd).unwrap();
    assert!(!s.cwd.join(".conf").exists(), "found again by its record, and taken back");
}

#[test]
fn a_dead_workspaces_record_that_cannot_be_set_aside_stops_the_sweep() {
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".k/conf", "a")]);
    fs::write(manifest(&s.root, "ws-9"), "not json").unwrap();
    lock(&s.root, true);
    prune(&s.root, &s.home, &[]).unwrap();
    lock(&s.root, false);
    assert_eq!(fs::read_to_string(s.cwd.join(".k/conf")).unwrap(), "a", "ws-9 might claim it");
    prune(&s.root, &s.home, &[]).unwrap();
    assert!(!s.cwd.join(".k").exists());
}

/// Older records of `ws`, each hidden by its whole first segment.
fn older_places(s: &Scratch, ws: &str, cwd: &Path, places: Vec<Place>) {
    let places = places.into_iter().map(|p| Place { hidden: Hidden::FirstSegment, ..p }).collect();
    Ledger::read(&s.root).unwrap().write(ws, places).unwrap();
    keepdeck_git::exclude::ensure_line(&cwd.join(".git"), "/.cfg/").unwrap();
}

#[test]
fn an_older_line_is_decided_once_over_every_entry_it_hides() {
    let s = scratch();
    let main = repo(&s);
    fs::create_dir_all(main.join(".cfg")).unwrap();
    fs::write(main.join(".cfg/b"), "the user's, since").unwrap();
    let file = || What::File { receipt: None };
    older_places(&s, "ws-1", &main, vec![place(&main, "p.filer", ".cfg/a", file()), place(&main, "p.filer", ".cfg/b", file())]);
    s.disarm(&main).unwrap();
    assert_eq!(excluded(&main), ["/.cfg/"], "one of its entries still holds something");
}

#[test]
fn an_older_line_goes_once_its_planting_is_hidden_by_its_own_exact_line() {
    let s = scratch();
    let main = repo(&s);
    let skills = s.skills("ws-1");
    fs::create_dir_all(main.join(".cfg")).unwrap();
    symlink(&skills, main.join(".cfg/l")).unwrap();
    older_places(&s, "ws-1", &main, vec![place(&main, "p.linker", ".cfg/l", What::Symlink { target: None })]);
    let report = s.arm_in(&main, "p.linker", "ws-1", &[link(".cfg/l", &skills)]);
    assert!(report.refused.is_empty(), "{:?}", report.refused);
    assert_eq!(excluded(&main), ["/.cfg/l"], "the broad line no longer hides the user's files beside it");
    assert!(s.places("ws-1").iter().all(|p| p.hidden == Hidden::Exact));
    s.arm_in(&main, "p.linker", "ws-1", &[]);
    assert!(excluded(&main).is_empty());
}

#[test]
fn only_codexs_older_folder_line_waits_for_a_link_alone() {
    let s = scratch();
    let main = repo(&s);
    fs::create_dir_all(main.join(".cfg")).unwrap();
    fs::write(main.join(".cfg/l"), "the user's, since").unwrap();
    let older = place(&main, "p.linker", ".cfg/l", What::Symlink { target: None });
    older_places(&s, "ws-1", &main, vec![older]);
    s.disarm(&main).unwrap();
    assert_eq!(excluded(&main), ["/.cfg/"], "anything standing there keeps another plugin's older line");
}

#[test]
fn a_pass_over_an_unchanged_set_looks_once_per_entry_and_writes_nothing() {
    let s = scratch();
    let main = repo(&s);
    let set: Vec<CwdArm> = (0..CAPS.entries_max)
        .map(|i| link(&format!(".agents/skills/s{i}"), &s.skill("ws-1", &format!("s{i}"))))
        .collect();
    let (first, cost) = s.pass(&main, "keepdeck.codex", "ws-1", &set);
    assert_eq!(first.armed.len(), CAPS.entries_max, "{:?}", first.refused);
    // The record: what the pass owes, the folders it made, what landed.
    assert_eq!((cost.manifests_written, cost.excludes_written), (3, 1));
    let (again, cost) = s.pass(&main, "keepdeck.codex", "ws-1", &set);
    assert_eq!(again.armed.len(), CAPS.entries_max);
    let unchanged = lifecycle::Stats { observed: CAPS.entries_max, digested: 0, manifests_written: 0, excludes_written: 0 };
    assert_eq!(cost, unchanged);
}

// ---- what a record of an owed line, a reserved name or a slot may do ----

#[test]
fn a_slot_is_one_name_in_every_unicode_spelling() {
    let s = scratch();
    let (one, two) = (s.skill("ws-1", "one"), s.skill("ws-1", "two"));
    assert!(s.arm("p.a", "ws-1", &[link(".x/caf\u{e9}", &one)]).refused.is_empty());
    let other = s.arm("p.b", "ws-1", &[link(".x/cafe\u{301}", &two)]);
    assert_eq!(refused(&other, ".x/cafe\u{301}"), ".x/cafe\u{301} is planted here by another agent");
    assert_eq!(fs::read_link(s.cwd.join(".x/caf\u{e9}")).unwrap(), one);
}

#[test]
fn an_owed_line_claims_no_slot_and_moves_nothing() {
    let s = scratch();
    let main = repo(&s);
    let skills = s.skills("ws-1");
    s.arm_in(&main, "p.a", "ws-1", &[link(".l", &skills)]);
    lock(&main.join(".git/info"), true);
    s.arm_in(&main, "p.a", "ws-1", &[]);
    lock(&main.join(".git/info"), false);
    assert!(fs::symlink_metadata(main.join(".l")).is_err(), "taken back; only its line is owed");
    let other = s.arm_in(&main, "p.b", "ws-1", &[link(".l", &skills)]);
    assert!(other.refused.is_empty(), "an owed line claims nothing: {:?}", other.refused);
}

#[test]
fn an_older_line_left_owed_is_no_authority_over_a_link_standing_there_later() {
    let s = scratch();
    let main = repo(&s);
    let skills = s.skills("ws-1");
    fs::create_dir_all(main.join(".cfg")).unwrap();
    symlink(&skills, main.join(".cfg/l")).unwrap();
    older_places(&s, "ws-1", &main, vec![place(&main, "p.linker", ".cfg/l", What::Symlink { target: None })]);
    lock(&main.join(".git/info"), true);
    s.disarm(&main).unwrap();
    lock(&main.join(".git/info"), false);
    assert!(fs::symlink_metadata(main.join(".cfg/l")).is_err());
    symlink(&skills, main.join(".cfg/l")).unwrap();
    s.disarm(&main).unwrap();
    assert_eq!(fs::read_link(main.join(".cfg/l")).unwrap(), skills, "no record planted this one");
    assert_eq!(excluded(&main), ["/.cfg/"], "and its older line stays while it stands");
}

#[test]
fn a_line_is_let_go_over_an_entry_only_once_that_entrys_own_line_is_written() {
    let s = scratch();
    let main = repo(&s);
    let skills = s.skills("ws-1");
    s.arm_in(&main, "p.linker", "ws-1", &[link(".cfg/l", &skills)]);
    let older = place(&main, "p.linker", ".cfg/l", What::Symlink { target: None });
    Ledger::read(&s.root).unwrap().write("ws-2", vec![Place { hidden: Hidden::FirstSegment, ..older }]).unwrap();
    keepdeck_git::exclude::ensure_line(&main.join(".git"), "/.cfg/").unwrap();
    keepdeck_git::exclude::remove_line(&main.join(".git"), "/.cfg/l").unwrap();
    prune(&s.root, &s.home, &["ws-1".into()]).unwrap();
    assert_eq!(fs::read_link(main.join(".cfg/l")).unwrap(), skills);
    assert_eq!(excluded(&main), ["/.cfg/l"], "never visible to git: its own line went back in first");
}

#[test]
fn a_failed_setup_changes_nothing_that_stands() {
    let s = scratch();
    let main = repo(&s);
    let skills = s.skills("ws-1");
    s.arm_in(&main, "p.linker", "ws-1", &[link(".l", &skills), link(".m", &skills)]);
    lock(&main.join(".git/info"), true);
    let report = s.arm_in(&main, "p.linker", "ws-1", &[link(".l", &skills), link(".n", &skills)]);
    lock(&main.join(".git/info"), false);
    assert_eq!(refused(&report, ".n"), "this could not be kept from git — nothing was planted");
    assert!(fs::symlink_metadata(main.join(".m")).is_ok(), "no take-back behind a failed setup");
    assert!(s.arm_in(&main, "p.linker", "ws-1", &[link(".l", &skills)]).refused.is_empty());
    assert!(fs::symlink_metadata(main.join(".m")).is_err());
    assert_eq!(excluded(&main), ["/.l"]);
}

#[test]
fn a_failed_setup_promotes_no_older_record() {
    let s = scratch();
    let main = repo(&s);
    let skills = s.skills("ws-1");
    fs::create_dir_all(main.join(".cfg")).unwrap();
    symlink(&skills, main.join(".cfg/l")).unwrap();
    older_places(&s, "ws-1", &main, vec![place(&main, "p.linker", ".cfg/l", What::Symlink { target: None })]);
    lock(&main.join(".git/info"), true);
    s.arm_in(&main, "p.linker", "ws-1", &[link(".cfg/l", &skills)]);
    lock(&main.join(".git/info"), false);
    let claims: Vec<Place> = s.places("ws-1").into_iter().filter(|p| p.claim().is_some()).collect();
    assert!(claims.iter().all(|p| p.hidden == Hidden::FirstSegment), "still hidden only as it was: {claims:?}");
    s.arm_in(&main, "p.linker", "ws-1", &[link(".cfg/l", &skills)]);
    assert!(s.places("ws-1").iter().all(|p| p.hidden == Hidden::Exact));
    assert_eq!(excluded(&main), ["/.cfg/l"]);
}

#[test]
fn a_reserved_names_leftover_goes_only_from_behind_the_fence() {
    // A crash left a staged file at its reserved name, recorded as made
    // there; while another record will not read, it stays.
    let s = scratch();
    s.arm("p.filer", "ws-1", &[file(".conf/other", "x")]);
    let dir = fsb::open_dir(&s.cwd.join(".conf")).unwrap();
    let staged = fsb::stage_at(&dir, &fsb::temporary_beside("mcp.json".as_ref()), b"ours", 0o644).unwrap();
    let mut places = s.places("ws-1");
    places.push(reserved(&s.cwd, &staged));
    Ledger::read(&s.root).unwrap().write("ws-1", places).unwrap();
    fs::write(manifest(&s.root, "ws-9"), "not json").unwrap();
    s.arm("p.filer", "ws-1", &[file(".conf/other", "x")]);
    assert!(s.cwd.join(".conf").join(&staged.name).exists());
    fs::remove_file(manifest(&s.root, "ws-9")).unwrap();
    s.arm("p.filer", "ws-1", &[file(".conf/other", "x")]);
    assert_eq!(fs::read_dir(s.cwd.join(".conf")).unwrap().count(), 1, "only the planting stays");
    assert!(s.places("ws-1").iter().all(|p| !matches!(p.what, What::Temp { .. })));
}

#[test]
fn a_reserved_name_proves_nothing_about_what_stands_at_it() {
    // A file that was already there when the name was tried (the exclusive
    // make failed), or a crash before the make was recorded; a link, even
    // one into this workspace's own skills: none of it is shown to be ours.
    let s = scratch();
    let skills = s.skills("ws-1");
    s.arm("p.filer", "ws-1", &[file(".conf/other", "x")]);
    fs::write(s.cwd.join(".conf/.a.1-1.keepdeck-tmp"), "the user's").unwrap();
    symlink(&skills, s.cwd.join(".conf/.b.1-2.keepdeck-tmp")).unwrap();
    let mut places = s.places("ws-1");
    for name in [".conf/.a.1-1.keepdeck-tmp", ".conf/.b.1-2.keepdeck-tmp"] {
        places.push(place(&s.cwd, "p.filer", name, What::Temp { made: None }));
    }
    // A record of another file made there proves nothing about this one.
    let other = fsb::identity_at(&fsb::open_dir(&s.cwd.join(".conf")).unwrap(), "other".as_ref()).unwrap();
    assert!(other.is_some());
    places.push(place(&s.cwd, "p.filer", ".conf/.a.1-1.keepdeck-tmp", What::Temp { made: other }));
    Ledger::read(&s.root).unwrap().write("ws-1", places).unwrap();
    s.disarm(&s.cwd).unwrap();
    assert_eq!(fs::read_to_string(s.cwd.join(".conf/.a.1-1.keepdeck-tmp")).unwrap(), "the user's");
    assert_eq!(fs::read_link(s.cwd.join(".conf/.b.1-2.keepdeck-tmp")).unwrap(), skills);
}

#[test]
fn a_line_that_cannot_be_worked_out_is_still_owed_and_no_more() {
    // An older record in a worktree whose git pointer will not read: its
    // planting goes, its line is owed unresolved — and a link standing at
    // that slot later is nothing that record may take back.
    let s = scratch();
    let main = repo(&s);
    let wt = worktree(&main, "wt");
    let skills = s.skills("ws-1");
    fs::create_dir_all(wt.join(".cfg")).unwrap();
    symlink(&skills, wt.join(".cfg/l")).unwrap();
    older_places(&s, "ws-1", &main, vec![place(&wt, "p.linker", ".cfg/l", What::Symlink { target: None })]);
    fs::set_permissions(wt.join(".git"), fs::Permissions::from_mode(0o000)).unwrap();
    let first = s.disarm(&wt);
    fs::set_permissions(wt.join(".git"), fs::Permissions::from_mode(0o644)).unwrap();
    first.unwrap();
    assert!(fs::symlink_metadata(wt.join(".cfg/l")).is_err());
    assert!(matches!(s.places("ws-1")[..], [Place { what: What::Line, owed: None, .. }]));
    symlink(&skills, wt.join(".cfg/l")).unwrap();
    s.disarm(&wt).unwrap();
    assert_eq!(fs::read_link(wt.join(".cfg/l")).unwrap(), skills, "no record planted this one");
}

#[test]
fn a_link_of_ours_is_repointed_and_one_a_crash_left_missing_is_made_again() {
    let s = scratch();
    let (one, two) = (s.skill("ws-1", "one"), s.skill("ws-1", "two"));
    s.arm("p.linker", "ws-1", &[link(".l", &one)]);
    let report = s.arm("p.linker", "ws-1", &[link(".l", &two)]);
    assert!(report.refused.is_empty(), "{:?}", report.refused);
    assert_eq!(fs::read_link(s.cwd.join(".l")).unwrap(), two);
    assert_eq!(fs::read_dir(&s.cwd).unwrap().count(), 1, "no temporary beside it");
    // Interrupted between giving way and the new link: the name is empty.
    fs::remove_file(s.cwd.join(".l")).unwrap();
    assert!(s.arm("p.linker", "ws-1", &[link(".l", &one)]).refused.is_empty());
    assert_eq!(fs::read_link(s.cwd.join(".l")).unwrap(), one);
}

#[test]
fn a_failed_setup_adopts_nothing_that_was_not_recorded() {
    let s = scratch();
    let main = repo(&s);
    let skills = s.skills("ws-1");
    symlink(&skills, main.join(".l")).unwrap();
    lock(&main.join(".git/info"), true);
    let report = s.arm_in(&main, "p.linker", "ws-1", &[link(".l", &skills)]);
    lock(&main.join(".git/info"), false);
    assert_eq!(refused(&report, ".l"), "this could not be kept from git — nothing was planted");
    assert!(s.places("ws-1").iter().all(|p| p.claim().is_none()), "at most the line it meant to owe");
    s.disarm(&main).unwrap();
    assert_eq!(fs::read_link(main.join(".l")).unwrap(), skills, "never claimed, never taken back");
}

#[test]
fn only_an_exact_line_of_its_own_covers_an_entry() {
    // ws-1's link was swapped for one into ws-2's skills, which an older
    // record of ws-2 names, hidden by a broad line no longer there. Letting
    // ws-1's exact line go must not bring that broad line back.
    let s = scratch();
    let main = repo(&s);
    s.arm_in(&main, "p.linker", "ws-1", &[link(".cfg/l", &s.skills("ws-1"))]);
    fs::remove_file(main.join(".cfg/l")).unwrap();
    symlink(s.skills("ws-2"), main.join(".cfg/l")).unwrap();
    let older = place(&main, "p.linker", ".cfg/l", What::Symlink { target: None });
    Ledger::read(&s.root).unwrap().write("ws-2", vec![Place { hidden: Hidden::FirstSegment, ..older }]).unwrap();
    s.arm_in(&main, "p.linker", "ws-1", &[]);
    assert_eq!(excluded(&main), ["/.cfg/l"], "the entry stays hidden exactly, its siblings visible");
}

#[test]
fn a_line_goes_with_its_planting_after_the_worktree_is_gone() {
    let s = scratch();
    let main = repo(&s);
    let wt = worktree(&main, "wt");
    s.arm_in(&wt, "p.linker", "ws-1", &[link(".l", &s.skills("ws-1"))]);
    assert_eq!(excluded(&main), ["/.l"]);
    git(&main, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
    s.disarm(&wt).unwrap();
    assert!(excluded(&main).is_empty(), "its record knew which repo and which line");
    assert!(s.places("ws-1").is_empty());
}

#[test]
fn nothing_is_hidden_from_git_that_could_not_be_recorded_first() {
    let s = scratch();
    let main = repo(&s);
    fs::create_dir_all(&s.root).unwrap();
    lock(&s.root, true);
    let report = s.arm_in(&main, "p.linker", "ws-1", &[link(".l", &s.skills("ws-1"))]);
    lock(&s.root, false);
    assert_eq!(refused(&report, ".l"), "KeepDeck's record of what it plants here could not be written");
    assert!(excluded(&main).is_empty(), "a line no record owes would never be let go");
}

#[test]
fn a_directory_whose_path_git_cannot_read_as_one_line_plants_nothing() {
    let s = scratch();
    let main = repo(&s);
    let cwd = main.join("pkg\nx");
    fs::create_dir_all(&cwd).unwrap();
    let report = s.arm_in(&cwd, "p.linker", "ws-1", &[link(".l", &s.skills("ws-1"))]);
    assert_eq!(refused(&report, ".l"), "this could not be kept from git — nothing was planted");
    assert!(fs::symlink_metadata(cwd.join(".l")).is_err());
    assert!(excluded(&main).is_empty());
}

#[test]
fn what_stands_as_declared_is_recorded_as_the_kind_it_is() {
    // The user replaced a planted file with exactly the link the next plan
    // declares: it is kept, and recorded — and taken back — as a link.
    let s = scratch();
    let skills = s.skills("ws-1");
    s.arm("p.mixed", "ws-1", &[file(".k", "a")]);
    fs::remove_file(s.cwd.join(".k")).unwrap();
    symlink(&skills, s.cwd.join(".k")).unwrap();
    let report = s.arm("p.mixed", "ws-1", &[link(".k", &skills)]);
    assert!(report.refused.is_empty(), "{:?}", report.refused);
    assert!(matches!(s.places("ws-1")[..], [Place { what: What::Symlink { .. }, .. }]));
    s.disarm(&s.cwd).unwrap();
    assert!(fs::symlink_metadata(s.cwd.join(".k")).is_err());
}

// ---- what a record may claim while a step is under way ----

#[test]
fn a_cwd_renamed_since_its_line_was_stamped_covers_only_what_that_line_hides() {
    // A link stamped as /before/.cfg/l; `before` became `after`, left behind
    // as a link to it. An older record of another workspace owes the broad
    // /after/.cfg/: the stale exact line hides nothing there, so the broad
    // one stays.
    let s = scratch();
    let main = repo(&s);
    let before = main.join("before");
    fs::create_dir_all(&before).unwrap();
    s.arm_in(&before, "p.linker", "ws-1", &[link(".cfg/l", &s.skills("ws-1"))]);
    let after = main.join("after");
    fs::rename(&before, &after).unwrap();
    symlink(&after, &before).unwrap();
    let older = place(&after, "p.linker", ".cfg/l", What::Symlink { target: None });
    Ledger::read(&s.root).unwrap().write("ws-2", vec![Place { hidden: Hidden::FirstSegment, ..older }]).unwrap();
    keepdeck_git::exclude::ensure_line(&main.join(".git"), "/after/.cfg/").unwrap();
    prune(&s.root, &s.home, &["ws-1".into()]).unwrap();
    assert!(excluded(&main).contains(&"/after/.cfg/".to_string()), "{:?}", excluded(&main));
}

#[test]
fn an_older_folder_link_that_would_not_give_way_keeps_every_record_of_it() {
    let s = scratch();
    let main = repo(&s);
    older_folder_link(&s, "ws-2", &main);
    let before = s.places("ws-2");
    lock(&main.join(".agents"), true);
    let report = s.arm_in(&main, "keepdeck.codex", "ws-1", &[link(".agents/skills/one", &s.skill("ws-1", "one"))]);
    lock(&main.join(".agents"), false);
    assert!(refused(&report, ".agents/skills/one").contains("could not give way"), "{:?}", report.refused);
    assert_eq!(s.places("ws-2"), before, "lowered for the step, restored when it did not happen");
}

#[test]
fn a_take_back_that_could_not_be_lowered_on_record_first_takes_nothing_back() {
    let s = scratch();
    let skills = s.skills("ws-1");
    s.arm("p.linker", "ws-1", &[link(".l", &skills)]);
    lock(&s.root, true);
    let swept = s.disarm(&s.cwd);
    lock(&s.root, false);
    assert!(swept.is_err());
    assert_eq!(fs::read_link(s.cwd.join(".l")).unwrap(), skills, "no link goes while its record still claims it");
    s.disarm(&s.cwd).unwrap();
    assert!(fs::symlink_metadata(s.cwd.join(".l")).is_err());
}
