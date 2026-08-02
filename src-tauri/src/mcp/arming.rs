//! Delivering MCP servers to kimi, which has no door but the filesystem.
//!
//! kimi 0.31 has no flag and no env for MCP config: its loader reads
//! `<cwd>/.kimi-code/mcp.json` (plus two paths KeepDeck must not touch — the
//! user's own home config, and the repo-shared `.mcp.json` claude also reads).
//! So a pane's cwd is ARMED with that file, exactly the way codex's skills are
//! armed with a symlink — same manifest, same exclude, same crash sweep
//! ([`crate::worktree_arm`]).
//!
//! Ownership is a MARKER FILE next to the config, not a guess about its
//! contents: `.kimi-code/.keepdeck-managed` says this `mcp.json` is ours to
//! rewrite and ours to take away. A cwd where the user already keeps their own
//! `mcp.json` is left completely alone — the pane simply gets no KeepDeck
//! server, which the app surfaces, because merging into a file the user wrote
//! would be editing their config.

use serde::Deserialize;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

use crate::state::write_atomic;
use crate::worktree_arm::{
    add_armed, ensure_excluded, forget_armed, prune_manifests, remove_excluded,
};

/// What arming plants in a pane's cwd — the directory git must stay blind to,
/// and the one kimi reads its MCP config from.
const PLANTED: &str = ".kimi-code";
const CONFIG_FILE: &str = "mcp.json";
/// Empty, and its mere presence is the claim: with it, the config beside it is
/// KeepDeck's to rewrite and to remove; without it, the config is the user's.
/// A marker rather than a shape test, so the day the server bank puts
/// third-party entries in this file, ownership does not have to be re-derived
/// from what the entries look like.
const MARKER_FILE: &str = ".keepdeck-managed";

/// One cwd and the config it should carry (mirrors the TS wire, camelCase).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpArmEntry {
    pub root: String,
    pub content: String,
}

/// Why a cwd could not be armed — the app names the pane and says so, rather
/// than leaving a kimi pane silently without the servers every other agent got.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpArmRefusal {
    pub root: String,
    pub reason: String,
}

/// The result of one arming pass (mirrors the TS wire, camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpArmReport {
    pub armed: Vec<String>,
    pub refused: Vec<McpArmRefusal>,
}

/// Arm every entry's cwd, and record what landed so a crashed workspace can
/// still be swept at the next boot. Best-effort per cwd: one odd directory
/// must not cost the others their servers.
///
/// The record is ADDED to, never replaced: a pane arms its own cwd and knows
/// nothing about its workspace's other panes, so replacing would erase them —
/// and a pass whose only cwd refused would delete the manifest, orphaning
/// everything the earlier panes planted.
pub(crate) fn arm(root: &Path, key: &str, entries: &[McpArmEntry]) -> McpArmReport {
    let mut report = McpArmReport::default();
    for entry in entries {
        let refusal = match arm_one(Path::new(&entry.root), &entry.content) {
            Ok(None) => None,
            Ok(Some(reason)) => Some(reason),
            Err(e) => Some(e.to_string()),
        };
        match refusal {
            None => report.armed.push(entry.root.clone()),
            Some(reason) => report.refused.push(McpArmRefusal {
                root: entry.root.clone(),
                reason,
            }),
        }
    }
    add_armed(root, key, &report.armed, "mcp");
    report
}

/// Arm one cwd. `Ok(None)` armed it; `Ok(Some(reason))` deliberately left it
/// alone and SAYS WHY.
///
/// The reason is the message the app puts in front of the user, so each of
/// these has to name what is actually there. They used to share one sentence
/// about the user's own config, which meant a directory that had simply been
/// deleted was reported as holding a file it does not have.
fn arm_one(cwd: &Path, content: &str) -> io::Result<Option<String>> {
    if !cwd.is_dir() {
        return Ok(Some("this directory no longer exists".into()));
    }
    let dir = cwd.join(PLANTED);
    // `.kimi-code` as anything but a real directory (a file, or a symlink into
    // the user's own tree) is theirs — writing through it would land inside
    // their target.
    match fs::symlink_metadata(&dir) {
        Ok(meta) if !meta.file_type().is_dir() => {
            return Ok(Some(format!("{PLANTED} here is not a directory")));
        }
        _ => {}
    }
    let config = dir.join(CONFIG_FILE);
    let marker = dir.join(MARKER_FILE);
    if fs::symlink_metadata(&config).is_ok() && !marker.exists() {
        return Ok(Some(format!("{PLANTED}/{CONFIG_FILE} here is not KeepDeck's")));
    }
    write_atomic(&marker, b"")?;
    if let Err(e) = write_atomic(&config, content.as_bytes()) {
        // The marker is a CLAIM on the config beside it. Left behind without
        // that config it is unreachable litter: no exclude line (that comes
        // below), no manifest entry (this cwd refuses), and every later pass
        // reads it as "ours" for a file that is not there.
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir(&dir);
        return Err(e);
    }
    if let Err(e) = ensure_excluded(cwd, PLANTED) {
        log::warn!("mcp: exclude line for {} failed: {e}", cwd.display());
    }
    Ok(None)
}

/// Take OUR config back out of the given cwds AND forget them.
///
/// Both halves, always: the record is what a crash sweep reads, so a cwd left
/// in it after its files are gone is a claim on a directory nothing owns any
/// more — and `claimed_by_others` would spare a dead workspace's real arming
/// on the strength of it.
pub(crate) fn disarm(root: &Path, cwds: &[String]) -> io::Result<()> {
    let result = disarm_files(cwds);
    forget_armed(root, cwds, "mcp");
    result
}

/// Take OUR config back out of the given cwds (and the directory it leaves
/// empty), and drop the exclude lines arming added. Anything without our
/// marker stays.
///
/// The manifest is NOT touched here: the prune path deletes the whole record
/// itself, so only [`disarm`] — the per-directory caller — owes a forget.
fn disarm_files(cwds: &[String]) -> io::Result<()> {
    for cwd in cwds {
        let dir = Path::new(cwd).join(PLANTED);
        if !dir.join(MARKER_FILE).exists() {
            continue;
        }
        for file in [CONFIG_FILE, MARKER_FILE] {
            match fs::remove_file(dir.join(file)) {
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                other => other?,
            }
        }
        // Only vanishes when our two files were its whole content — kimi may
        // keep state of its own in there.
        let _ = fs::remove_dir(&dir);
        if let Err(e) = remove_excluded(Path::new(cwd), PLANTED) {
            log::warn!("mcp: exclude cleanup for {cwd} failed: {e}");
        }
    }
    Ok(())
}

/// Sweep the cwds of workspaces that are gone — the crash path, where the deck
/// no longer knows the directories but the manifest does.
pub(crate) fn prune(root: &Path, live: &[String]) -> io::Result<()> {
    prune_manifests(root, live, "mcp", disarm_files)
}

/// Where the armed manifests live: beside the socket, in KeepDeck's own home.
pub(crate) fn arming_root() -> Result<std::path::PathBuf, String> {
    crate::paths::mcp_socket()
        .and_then(|socket| socket.parent().map(Path::to_path_buf))
        .ok_or_else(|| "no home directory to record MCP arming".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("mcp");
        let cwd = tmp.path().join("repo");
        fs::create_dir_all(&cwd).unwrap();
        (tmp, root, cwd)
    }

    fn entry(cwd: &Path, content: &str) -> McpArmEntry {
        McpArmEntry {
            root: cwd.to_string_lossy().into_owned(),
            content: content.to_string(),
        }
    }

    #[test]
    fn arming_writes_the_config_kimi_reads_and_claims_it_with_a_marker() {
        let (_tmp, root, cwd) = scratch();
        let report = arm(&root, "ws-1", &[entry(&cwd, "{\"mcpServers\":{}}")]);

        assert_eq!(report.armed, vec![cwd.to_string_lossy().into_owned()]);
        assert!(report.refused.is_empty());
        let config = cwd.join(".kimi-code").join("mcp.json");
        assert_eq!(fs::read_to_string(&config).unwrap(), "{\"mcpServers\":{}}");
        assert!(cwd.join(".kimi-code").join(".keepdeck-managed").exists());
    }

    #[test]
    fn a_config_the_user_wrote_is_never_touched_or_removed() {
        // Merging into it would be editing the user's own agent config — the
        // one thing this feature must never do. The pane goes without.
        let (_tmp, root, cwd) = scratch();
        let dir = cwd.join(".kimi-code");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("mcp.json"), "{\"mcpServers\":{\"theirs\":{}}}").unwrap();

        let report = arm(&root, "ws-1", &[entry(&cwd, "{\"mcpServers\":{}}")]);

        assert!(report.armed.is_empty());
        assert_eq!(report.refused.len(), 1);
        assert_eq!(
            fs::read_to_string(dir.join("mcp.json")).unwrap(),
            "{\"mcpServers\":{\"theirs\":{}}}",
        );

        // And a disarm that sweeps this cwd leaves it alone too.
        disarm(&root, &[cwd.to_string_lossy().into_owned()]).unwrap();
        assert!(dir.join("mcp.json").exists());
    }

    #[test]
    fn re_arming_rewrites_our_own_config_in_place() {
        let (_tmp, root, cwd) = scratch();
        arm(&root, "ws-1", &[entry(&cwd, "{\"first\":true}")]);
        let report = arm(&root, "ws-1", &[entry(&cwd, "{\"second\":true}")]);

        assert_eq!(report.armed.len(), 1);
        assert_eq!(
            fs::read_to_string(cwd.join(".kimi-code").join("mcp.json")).unwrap(),
            "{\"second\":true}",
        );
    }

    #[test]
    fn disarming_takes_both_files_and_the_directory_it_emptied() {
        let (_tmp, root, cwd) = scratch();
        arm(&root, "ws-1", &[entry(&cwd, "{}")]);

        disarm(&root, &[cwd.to_string_lossy().into_owned()]).unwrap();

        assert!(!cwd.join(".kimi-code").exists());
    }

    #[test]
    fn disarming_keeps_a_directory_kimi_still_has_state_in() {
        let (_tmp, root, cwd) = scratch();
        arm(&root, "ws-1", &[entry(&cwd, "{}")]);
        fs::write(cwd.join(".kimi-code").join("sessions.json"), "kimi's").unwrap();

        disarm(&root, &[cwd.to_string_lossy().into_owned()]).unwrap();

        assert!(!cwd.join(".kimi-code").join("mcp.json").exists());
        assert!(cwd.join(".kimi-code").join("sessions.json").exists());
    }

    #[test]
    fn a_directory_that_is_gone_is_refused_not_created() {
        // A pane whose worktree was removed must not have its cwd recreated
        // by an arming that raced the teardown.
        let (_tmp, root, cwd) = scratch();
        let missing = cwd.join("nope");
        let report = arm(&root, "ws-1", &[entry(&missing, "{}")]);

        assert!(report.armed.is_empty());
        assert!(!missing.exists());
    }

    #[test]
    fn a_crashed_workspaces_cwds_are_swept_at_the_next_boot() {
        let (_tmp, root, cwd) = scratch();
        arm(&root, "ws-dead", &[entry(&cwd, "{}")]);

        prune(&root, &["ws-live".into()]).unwrap();

        assert!(!cwd.join(".kimi-code").exists());
    }

    #[test]
    fn a_cwd_a_live_workspace_still_claims_survives_the_sweep() {
        // Two workspaces may legitimately run panes in one folder; one dying
        // must not take the other's servers away.
        let (_tmp, root, cwd) = scratch();
        arm(&root, "ws-dead", &[entry(&cwd, "{}")]);
        arm(&root, "ws-live", &[entry(&cwd, "{}")]);

        prune(&root, &["ws-live".into()]).unwrap();

        assert!(cwd.join(".kimi-code").join("mcp.json").exists());
    }

    #[test]
    fn each_pane_adds_to_the_record_instead_of_replacing_it() {
        // A pane arms its OWN cwd and knows nothing about its workspace's
        // other panes. Replacing here would erase them, and the sweep would
        // never find what they planted.
        let (_tmp, root, cwd) = scratch();
        let second = cwd.parent().unwrap().join("other-pane");
        fs::create_dir_all(&second).unwrap();

        arm(&root, "ws-1", &[entry(&cwd, "{}")]);
        arm(&root, "ws-1", &[entry(&second, "{}")]);

        let recorded: Vec<String> =
            serde_json::from_slice(&fs::read(root.join("armed").join("ws-1")).unwrap()).unwrap();
        assert_eq!(
            recorded,
            vec![
                cwd.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
        );
    }

    #[test]
    fn a_pass_that_arms_nothing_leaves_the_record_alone() {
        // The destructive shape this replaced: a pane whose cwd holds the
        // user's own config armed nothing, and the empty result deleted the
        // whole workspace's record — orphaning every earlier pane's files.
        let (_tmp, root, cwd) = scratch();
        arm(&root, "ws-1", &[entry(&cwd, "{}")]);

        let theirs = cwd.parent().unwrap().join("theirs");
        fs::create_dir_all(theirs.join(".kimi-code")).unwrap();
        fs::write(theirs.join(".kimi-code").join("mcp.json"), "{}").unwrap();
        let report = arm(&root, "ws-1", &[entry(&theirs, "{}")]);

        assert_eq!(report.refused.len(), 1);
        let recorded: Vec<String> =
            serde_json::from_slice(&fs::read(root.join("armed").join("ws-1")).unwrap()).unwrap();
        assert_eq!(recorded, vec![cwd.to_string_lossy().into_owned()]);
    }

    #[test]
    fn a_refusal_names_what_is_actually_there() {
        // The reason is the message the app puts in front of the user, and
        // the fix differs per reason. One asserted sentence about the user's
        // own config sent them looking for a file that is not there.
        let (_tmp, root, cwd) = scratch();

        let gone = cwd.parent().unwrap().join("deleted-worktree");
        let missing = arm(&root, "ws-1", &[entry(&gone, "{}")]);
        assert_eq!(missing.refused[0].reason, "this directory no longer exists");

        let blocked = cwd.parent().unwrap().join("blocked");
        fs::create_dir_all(&blocked).unwrap();
        fs::write(blocked.join(".kimi-code"), "a file, not a directory").unwrap();
        let not_a_dir = arm(&root, "ws-1", &[entry(&blocked, "{}")]);
        assert_eq!(not_a_dir.refused[0].reason, ".kimi-code here is not a directory");

        let theirs = cwd.parent().unwrap().join("theirs");
        fs::create_dir_all(theirs.join(".kimi-code")).unwrap();
        fs::write(theirs.join(".kimi-code").join("mcp.json"), "{}").unwrap();
        let not_ours = arm(&root, "ws-1", &[entry(&theirs, "{}")]);
        assert_eq!(
            not_ours.refused[0].reason,
            ".kimi-code/mcp.json here is not KeepDeck's",
        );
    }

    #[test]
    fn disarming_a_cwd_forgets_it_too() {
        // The record is what a CRASH sweep reads. A cwd left in it after its
        // files are gone is a claim on a directory nothing owns any more —
        // and `claimed_by_others` would then spare a dead workspace's real
        // arming on the strength of that stale claim.
        let (_tmp, root, cwd) = scratch();
        let second = cwd.parent().unwrap().join("other-pane");
        fs::create_dir_all(&second).unwrap();
        arm(&root, "ws-1", &[entry(&cwd, "{}"), entry(&second, "{}")]);

        disarm(&root, &[cwd.to_string_lossy().into_owned()]).unwrap();

        let recorded: Vec<String> =
            serde_json::from_slice(&fs::read(root.join("armed").join("ws-1")).unwrap()).unwrap();
        assert_eq!(recorded, vec![second.to_string_lossy().into_owned()]);
    }

    #[test]
    fn disarming_the_last_cwd_drops_the_record_entirely() {
        let (_tmp, root, cwd) = scratch();
        arm(&root, "ws-1", &[entry(&cwd, "{}")]);

        disarm(&root, &[cwd.to_string_lossy().into_owned()]).unwrap();

        assert!(!root.join("armed").join("ws-1").exists());
    }

    #[test]
    fn a_shared_cwd_stops_being_claimed_by_the_workspace_that_left() {
        // Two workspaces ran a pane in one folder; one is disarmed. The other
        // still claims it — but the departed one must not, or a later prune
        // spares that folder forever on a claim nobody is making.
        let (_tmp, root, cwd) = scratch();
        arm(&root, "ws-1", &[entry(&cwd, "{}")]);
        arm(&root, "ws-2", &[entry(&cwd, "{}")]);

        disarm(&root, &[cwd.to_string_lossy().into_owned()]).unwrap();

        assert!(!root.join("armed").join("ws-1").exists());
        assert!(!root.join("armed").join("ws-2").exists());
    }
}
