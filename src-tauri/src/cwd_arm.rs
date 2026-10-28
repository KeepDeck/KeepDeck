//! Arming a pane's working directory with what an agent's plugin declares
//! (`AgentHooks["arm.plan"]`, plugin API 72): a file, or a symlink, at a path
//! relative to the cwd — for a CLI whose only door for something is a place
//! in the directory it starts in.
//!
//! The PLUGIN says what is planted; this engine owns everything that makes
//! planting in a user's directory safe, the same for every agent:
//!
//! - nothing of the user's is ever written over or removed. An entry already
//!   at a path is ours only when this plugin's record names it: a file only
//!   beside our `.keepdeck-managed` marker too, a symlink only while it still
//!   points where we made it point. A marker or a matching target alone
//!   proves nothing — the user may keep a file beside our marker, or a link
//!   to the very same place. A parent on the way that is a file or a link is
//!   the user's, and nothing is written through it;
//! - a symlink may only point at something that exists inside the plugin's
//!   own workspace directory or the skills directory handed to this plan —
//!   judged, and made, on the real location;
//! - one path in one directory belongs to one plugin, and a path is the entry
//!   it names, not its spelling: a case-insensitive volume makes `mcp.json`
//!   and `MCP.json` one file, and a cwd reached through a symlink is the same
//!   cwd;
//! - git is kept blind to what was planted (the path's first segment, in the
//!   owning repo's `info/exclude`, marked as ours), and stops being blind once
//!   nothing of ours is left under that line — in any worktree sharing it;
//! - every planting is recorded per workspace (`cwd-arms/<ws>.json`) BEFORE it
//!   is made, so a crash leaves a record for nothing rather than a planting no
//!   record names; a workspace that dies in a crash can still be swept at the
//!   next boot, and a directory two workspaces share loses a planting only
//!   with its last record.
//!
//! Each `arm` call speaks for ONE plugin in ONE directory, and for its whole
//! set there: what it no longer declares is taken back. The host orders every
//! call against worktree teardown; the lock here only keeps two calls from
//! interleaving their manifest writes.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::state::write_atomic;
use crate::worktree_arm::{ensure_excluded, exclusion, remove_excluded};

/// Beside a planted file: with it AND a record, the file is ours to rewrite
/// and to remove.
const MARKER_FILE: &str = ".keepdeck-managed";

/// Manifest read-modify-writes, one at a time.
static LOCK: Mutex<()> = Mutex::new(());

/// One thing a plugin wants in the pane's cwd (mirrors the TS `CwdArm`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CwdArm {
    File { path: String, content: String },
    Symlink { path: String, target: String },
}

impl CwdArm {
    fn path(&self) -> &str {
        match self {
            CwdArm::File { path, .. } | CwdArm::Symlink { path, .. } => path,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ArmKind {
    File,
    Symlink,
}

/// One planting, as the manifest remembers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArmRecord {
    /// The cwd's real path (older records may hold another spelling; they
    /// are read as the real one, see [`read_records`]).
    cwd: String,
    plugin: String,
    path: String,
    kind: ArmKind,
    /// A symlink's target, exactly as created — what proves the link ours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

impl ArmRecord {
    /// Whether this record names the same entry as `path` in `cwd`.
    fn at(&self, cwd: &str, path: &str) -> bool {
        self.cwd == cwd && same_entry(Path::new(cwd), &self.path, path)
    }
}

/// Two relative paths in one directory name the same entry when they are
/// spelled alike ignoring case, or when both exist as one entry on disk (a
/// Unicode spelling the volume folds). Cautious by design: on a
/// case-sensitive volume `a` and `A` are two files, and this still calls them
/// one — refusing a name is better than writing over another agent's file.
fn same_entry(cwd: &Path, a: &str, b: &str) -> bool {
    a == b || a.to_lowercase() == b.to_lowercase() || same_file(&cwd.join(a), &cwd.join(b))
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(_a: &Path, _b: &Path) -> bool {
    false
}

/// A directory as one spelling: its real path while it exists, else as
/// written — so a cwd reached through a symlink, or spelled with `..`, is the
/// cwd it is.
fn canonical(dir: &str) -> String {
    fs::canonicalize(dir).map_or_else(|_| dir.to_string(), |real| real.to_string_lossy().into_owned())
}

/// A path we did not plant, and why — in words the app puts on screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmRefusal {
    pub path: String,
    pub reason: String,
}

/// One arming pass (mirrors the TS wire, camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdArmReport {
    pub armed: Vec<String>,
    pub refused: Vec<ArmRefusal>,
}

/// Arm `cwd` with exactly `arms` for `plugin`, on behalf of workspace `ws`.
#[tauri::command(async)]
pub fn cwd_arm(
    plugin_id: String,
    ws_id: String,
    cwd: String,
    arms: Vec<CwdArm>,
    skills_dir: Option<String>,
) -> Result<CwdArmReport, String> {
    if !crate::plugin_workspaces::is_plugin_id(&plugin_id) {
        return Err(format!("unsafe plugin id: {plugin_id:?}"));
    }
    if !crate::fs_names::is_safe_segment(&ws_id) {
        return Err(format!("unsafe workspace id: {ws_id:?}"));
    }
    let home = crate::paths::keepdeck_home().ok_or("no home directory for cwd arming")?;
    let mut allowed = vec![home.join("plugin-workspaces").join(&plugin_id).join(&ws_id)];
    allowed.extend(skills_dir.map(PathBuf::from));
    Ok(arm(&records_root(&home), &plugin_id, &ws_id, &cwd, &arms, &allowed))
}

/// Take back everything planted in these cwds, for every plugin and
/// workspace — except in a cwd one of `live_roots` still is. Returns the cwds
/// released, as asked for.
#[tauri::command(async)]
pub fn cwd_disarm(roots: Vec<String>, live_roots: Vec<String>) -> Result<Vec<String>, String> {
    disarm(&root()?, &roots, &live_roots).map_err(|e| e.to_string())
}

/// Sweep what workspaces that no longer exist planted — the crash path.
#[tauri::command(async)]
pub fn cwd_arm_prune(live_ws_ids: Vec<String>) -> Result<(), String> {
    prune(&root()?, &live_ws_ids).map_err(|e| e.to_string())
}

/// Where the per-workspace records live under KeepDeck's home.
pub(crate) fn records_root(home: &Path) -> PathBuf {
    home.join("cwd-arms")
}

fn root() -> Result<PathBuf, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for cwd arming")?;
    Ok(records_root(&home))
}

fn manifest(root: &Path, ws: &str) -> PathBuf {
    root.join(format!("{ws}.json"))
}

/// A workspace's records: empty when it has none, an error when the file is
/// there and will not read — evidence of plantings we can no longer locate.
fn read_records(root: &Path, ws: &str) -> io::Result<Vec<ArmRecord>> {
    let mut records: Vec<ArmRecord> = match fs::read(manifest(root, ws)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
        Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    for record in &mut records {
        record.cwd = canonical(&record.cwd);
    }
    Ok(records)
}

fn write_records(root: &Path, ws: &str, records: &[ArmRecord]) -> io::Result<()> {
    let path = manifest(root, ws);
    if records.is_empty() {
        return match fs::remove_file(&path) {
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            other => other,
        };
    }
    fs::create_dir_all(root)?;
    write_atomic(&path, &serde_json::to_vec(records).map_err(io::Error::other)?)
}

/// Every workspace's records, by workspace id, and the workspaces whose
/// record will not read — whose claims nobody can know.
struct Ledger {
    records: Vec<(String, Vec<ArmRecord>)>,
    unreadable: Vec<String>,
}

fn all_records(root: &Path) -> io::Result<Ledger> {
    let mut ledger = Ledger { records: Vec::new(), unreadable: Vec::new() };
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(ledger),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(ws) = name.strip_suffix(".json") else { continue };
        match read_records(root, ws) {
            Ok(records) => ledger.records.push((ws.to_string(), records)),
            Err(e) => {
                log::warn!("cwd arming: the record of {ws} is unreadable: {e}");
                ledger.unreadable.push(ws.to_string());
            }
        }
    }
    Ok(ledger)
}

/// What a pass that takes things back may not do while a record will not
/// read: it could be the one naming what would go.
fn readable(ledger: &Ledger) -> io::Result<()> {
    match ledger.unreadable.first() {
        Some(ws) => Err(io::Error::other(format!(
            "the record of {ws} is unreadable — nothing was taken back"
        ))),
        None => Ok(()),
    }
}

/// Whether any workspace records `path` in `cwd` — asked by the retirement of
/// what older builds planted, so it never takes back what this engine planted
/// at the same place. An unreadable record answers with an error: it may.
pub(crate) fn recorded_at(root: &Path, cwd: &Path, path: &str) -> io::Result<bool> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let ledger = all_records(root)?;
    readable(&ledger)?;
    let cwd = canonical(&cwd.to_string_lossy());
    Ok(ledger.records.iter().flat_map(|(_, records)| records).any(|r| r.at(&cwd, path)))
}

fn arm(
    root: &Path,
    plugin: &str,
    ws: &str,
    cwd: &str,
    arms: &[CwdArm],
    allowed: &[PathBuf],
) -> CwdArmReport {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let refuse_all = |reason: &str| CwdArmReport {
        armed: Vec::new(),
        refused: arms
            .iter()
            .map(|arm| ArmRefusal { path: arm.path().to_string(), reason: reason.to_string() })
            .collect(),
    };
    let cwd = match fs::canonicalize(cwd) {
        Ok(real) if real.is_dir() => real.to_string_lossy().into_owned(),
        _ => return refuse_all("this directory no longer exists"),
    };
    let cwd = cwd.as_str();
    let mine = match read_records(root, ws) {
        Ok(records) => records,
        Err(e) => {
            log::warn!("cwd arming: the record of {ws} is unreadable: {e}");
            return refuse_all("KeepDeck's record of what it planted here could not be read");
        }
    };
    let others: Vec<ArmRecord> = match all_records(root) {
        Ok(ledger) => ledger.records.into_iter().filter(|(id, _)| id != ws).flat_map(|(_, r)| r).collect(),
        Err(e) => {
            log::warn!("cwd arming: reading the records failed: {e}");
            return refuse_all("KeepDeck's record of what it planted here could not be read");
        }
    };
    let allowed: Vec<PathBuf> = allowed.iter().filter_map(|dir| fs::canonicalize(dir).ok()).collect();

    let mut report = CwdArmReport::default();
    let mut planted: Vec<ArmRecord> = Vec::new();
    // The manifest as written so far: the records before this pass, plus each
    // planting's record written before the planting is made.
    let mut ledger = mine.clone();
    let mut seen = BTreeSet::new();
    for arm in arms {
        let path = arm.path();
        let refusal = if !seen.insert(path.to_lowercase()) {
            Some(format!("{path} is declared twice"))
        } else if mine
            .iter()
            .chain(others.iter())
            .chain(planted.iter())
            .any(|r| r.at(cwd, path) && r.plugin != plugin)
        {
            Some(format!("{path} is planted here by another agent"))
        } else {
            match admit(cwd, plugin, arm, &allowed) {
                Err(reason) => Some(reason),
                Ok(record) => {
                    if !ledger.contains(&record) {
                        ledger.push(record.clone());
                    }
                    match write_records(root, ws, &ledger) {
                        Err(e) => {
                            log::warn!("cwd arming: recording {ws} failed: {e}");
                            Some("KeepDeck's record of what it plants here could not be written".to_string())
                        }
                        Ok(()) => match plant(cwd, arm, &record, mine.iter().chain(others.iter())) {
                            Ok(Ok(())) => {
                                planted.push(record);
                                None
                            }
                            Ok(Err(reason)) => Some(reason),
                            Err(e) => Some(e.to_string()),
                        },
                    }
                }
            }
        };
        match refusal {
            None => report.armed.push(path.to_string()),
            Some(reason) => report.refused.push(ArmRefusal { path: path.to_string(), reason }),
        }
    }

    // What this plugin planted here before and no longer declares goes —
    // unless another workspace still records it.
    let (stale, kept): (Vec<ArmRecord>, Vec<ArmRecord>) = mine
        .into_iter()
        .partition(|r| r.cwd == cwd && r.plugin == plugin && !planted.iter().any(|p| p.path == r.path));
    let mut records = kept;
    records.retain(|r| !(r.cwd == cwd && r.plugin == plugin));
    records.extend(planted.iter().cloned());
    let remaining: Vec<&ArmRecord> = records.iter().chain(others.iter()).collect();
    for record in &stale {
        if !remaining.iter().any(|r| r.at(&record.cwd, &record.path)) {
            if let Err(e) = take_back(record, &remaining) {
                log::warn!("cwd arming: taking back {}/{} failed: {e}", record.cwd, record.path);
            }
        }
    }
    if let Err(e) = write_records(root, ws, &records) {
        log::warn!("cwd arming: recording {ws} failed: {e}");
    }
    report
}

/// The record an arm would leave, or why it may not be planted at all.
fn admit(cwd: &str, plugin: &str, arm: &CwdArm, allowed: &[PathBuf]) -> Result<ArmRecord, String> {
    let path = arm.path();
    if relative_parts(path).is_none() {
        return Err(format!("{path} is not a path inside this directory"));
    }
    let (kind, target) = match arm {
        CwdArm::File { .. } => (ArmKind::File, None),
        CwdArm::Symlink { target, .. } => {
            let Some(real) = link_target(target, allowed) else {
                return Err(format!("{path} would point outside what this agent may link to"));
            };
            (ArmKind::Symlink, Some(real))
        }
    };
    Ok(ArmRecord { cwd: cwd.to_string(), plugin: plugin.to_string(), path: path.to_string(), kind, target })
}

/// Where a link may point: an absolute path without `..` that exists, whose
/// real location sits inside one of `allowed` (real paths too) — returned as
/// that real location, which is what the link is made to. A target that does
/// not exist yet is refused: nothing could promise where it will resolve.
fn link_target(target: &str, allowed: &[PathBuf]) -> Option<String> {
    let path = Path::new(target);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let real = fs::canonicalize(path).ok()?;
    allowed.iter().any(|dir| real.starts_with(dir)).then(|| real.to_string_lossy().into_owned())
}

/// Plant one admitted arm. `Ok(Err(reason))` deliberately left it alone and
/// says why. `recorded` is what the manifests said before this pass — the
/// only proof an entry already there is ours.
fn plant<'a>(
    cwd: &str,
    arm: &CwdArm,
    record: &ArmRecord,
    recorded: impl Iterator<Item = &'a ArmRecord> + Clone,
) -> io::Result<Result<(), String>> {
    let path = arm.path();
    let Some(parts) = relative_parts(path) else {
        return Ok(Err(format!("{path} is not a path inside this directory")));
    };
    let base = Path::new(cwd);
    // Every directory on the way must be a real one, or not there yet: a file
    // or a link there is the user's, and writing through it would land in
    // their target.
    let mut at = base.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(meta) if !meta.file_type().is_dir() => {
                let shown = at.strip_prefix(base).unwrap_or(&at).display().to_string();
                return Ok(Err(format!("{shown} here is not a directory")));
            }
            _ => {}
        }
    }
    let ours = |kind: ArmKind, target: Option<&Path>| {
        recorded.clone().any(|r| {
            r.at(cwd, path)
                && r.plugin == record.plugin
                && r.kind == kind
                && target.is_none_or(|t| r.target.as_deref().map(Path::new) == Some(t))
        })
    };
    let full = base.join(path);
    match arm {
        CwdArm::File { content, .. } => {
            let dir = full.parent().unwrap_or(base).to_path_buf();
            let marker = dir.join(MARKER_FILE);
            match fs::symlink_metadata(&full) {
                Ok(meta) if !meta.file_type().is_file() => {
                    return Ok(Err(format!("{path} here is not KeepDeck's")));
                }
                Ok(_) if !marker.exists() || !ours(ArmKind::File, None) => {
                    return Ok(Err(format!("{path} here is not KeepDeck's")));
                }
                Ok(_) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            let claimed_before = marker.exists();
            fs::create_dir_all(&dir)?;
            write_atomic(&marker, b"")?;
            if let Err(e) = write_atomic(&full, content.as_bytes()) {
                // A claim this call made with nothing beside it would read as
                // ours for a file that is not there.
                if !claimed_before {
                    let _ = fs::remove_file(&marker);
                    remove_empty_up_to(&dir, base);
                }
                return Err(e);
            }
        }
        CwdArm::Symlink { .. } => {
            let target = Path::new(record.target.as_deref().unwrap_or_default());
            match fs::symlink_metadata(&full) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    let current = fs::read_link(&full)?;
                    if !ours(ArmKind::Symlink, Some(&current)) {
                        return Ok(Err(if current == target {
                            format!("{path} is your own — nothing was planted")
                        } else {
                            format!("{path} points somewhere else — it is not ours to replace")
                        }));
                    }
                    if current != target {
                        fs::remove_file(&full)?;
                        symlink_dir(target, &full)?;
                    }
                }
                Ok(_) => return Ok(Err(format!("{path} is your own — nothing was planted"))),
                Err(e) if e.kind() == ErrorKind::NotFound => {
                    if let Some(dir) = full.parent() {
                        fs::create_dir_all(dir)?;
                    }
                    symlink_dir(target, &full)?;
                }
                Err(e) => return Err(e),
            }
        }
    }
    exclude(base, &parts[0]);
    Ok(Ok(()))
}

/// Take one recorded planting back out of its cwd, if it is still ours; the
/// marker goes once no recorded file is left beside it, the exclude line once
/// nothing that shares it is left. A file whose marker is gone is no longer
/// provably ours and stays — but the exclude line we added still goes.
fn take_back(record: &ArmRecord, remaining: &[&ArmRecord]) -> io::Result<()> {
    let base = Path::new(&record.cwd);
    let Some(parts) = relative_parts(&record.path) else { return Ok(()) };
    let full = base.join(&record.path);
    let dir = full.parent().unwrap_or(base).to_path_buf();
    match record.kind {
        ArmKind::File => {
            let marker = dir.join(MARKER_FILE);
            if marker.exists() {
                match fs::symlink_metadata(&full) {
                    Ok(meta) if meta.file_type().is_file() => fs::remove_file(&full)?,
                    Ok(_) => {}
                    Err(e) if e.kind() == ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
                let still_beside = remaining.iter().any(|r| {
                    r.cwd == record.cwd
                        && r.kind == ArmKind::File
                        && base.join(&r.path).parent() == Some(dir.as_path())
                });
                if !still_beside {
                    let _ = fs::remove_file(&marker);
                }
            }
        }
        ArmKind::Symlink => {
            if let Some(target) = &record.target {
                match fs::symlink_metadata(&full) {
                    Ok(meta)
                        if meta.file_type().is_symlink()
                            && fs::read_link(&full)? == Path::new(target) =>
                    {
                        fs::remove_file(&full)?
                    }
                    _ => {}
                }
            }
        }
    }
    remove_empty_up_to(&dir, base);
    release_exclusion(base, &parts[0], remaining);
    Ok(())
}

/// Stop hiding `segment` of `base` from git, unless a remaining planting —
/// in this cwd or another worktree of the same repo — shares the line.
fn release_exclusion(base: &Path, segment: &str, remaining: &[&ArmRecord]) {
    let line = match exclusion(base, segment) {
        Ok(Some(line)) => line,
        Ok(None) => return,
        Err(e) => {
            log::warn!("cwd arming: exclude lookup for {} failed: {e}", base.display());
            return;
        }
    };
    let shared = remaining.iter().any(|r| {
        relative_parts(&r.path)
            .and_then(|parts| exclusion(Path::new(&r.cwd), &parts[0]).ok().flatten())
            .is_some_and(|theirs| theirs == line)
    });
    if !shared {
        if let Err(e) = remove_excluded(base, segment) {
            log::warn!("cwd arming: exclude cleanup for {} failed: {e}", base.display());
        }
    }
}

/// Take back what was planted in `roots`, except in a root one of `live` still
/// is, however either is spelled — the last guard under the host's. Returns
/// the roots released, spelled as asked.
fn disarm(root: &Path, roots: &[String], live: &[String]) -> io::Result<Vec<String>> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let live: BTreeSet<String> = live.iter().map(|r| canonical(r)).collect();
    let mut released: Vec<String> = Vec::new();
    for requested in roots {
        if !live.contains(&canonical(requested)) && !released.contains(requested) {
            released.push(requested.clone());
        }
    }
    if released.is_empty() {
        return Ok(released);
    }
    let gone_roots: BTreeSet<String> = released.iter().map(|r| canonical(r)).collect();
    let ledger = all_records(root)?;
    readable(&ledger)?;
    let (gone, kept): (Vec<ArmRecord>, Vec<ArmRecord>) = ledger
        .records
        .iter()
        .flat_map(|(_, records)| records.iter().cloned())
        .partition(|r| gone_roots.contains(&r.cwd));
    let result = take_back_all(&gone, &kept);
    for (ws, records) in ledger.records {
        let left: Vec<ArmRecord> = records.into_iter().filter(|r| !gone_roots.contains(&r.cwd)).collect();
        write_records(root, &ws, &left)?;
    }
    result.map(|()| released)
}

/// Dead workspaces' plantings go, except what a live one still records. A
/// dead workspace's unreadable record is set aside (its plantings stay where
/// they are, unclaimed); while a LIVE one's will not read, nothing goes.
fn prune(root: &Path, live: &[String]) -> io::Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let ledger = all_records(root)?;
    for ws in ledger.unreadable.iter().filter(|ws| !live.contains(ws)) {
        let aside = root.join(format!("{ws}.json.unreadable"));
        if let Err(e) = fs::rename(manifest(root, ws), aside) {
            log::warn!("cwd arming: setting the unreadable record of {ws} aside failed: {e}");
        }
    }
    if let Some(ws) = ledger.unreadable.iter().find(|ws| live.contains(ws)) {
        log::warn!("cwd arming: the record of live {ws} is unreadable — nothing swept");
        return Ok(());
    }
    let (dead, alive): (Vec<_>, Vec<_>) = ledger.records.into_iter().partition(|(ws, _)| !live.contains(ws));
    let gone: Vec<ArmRecord> = dead.iter().flat_map(|(_, r)| r.iter().cloned()).collect();
    let kept: Vec<ArmRecord> = alive.into_iter().flat_map(|(_, r)| r).collect();
    if let Err(e) = take_back_all(&gone, &kept) {
        log::warn!("cwd arming: sweeping dead workspaces failed: {e}");
    }
    for (ws, _) in &dead {
        let _ = fs::remove_file(manifest(root, ws));
    }
    Ok(())
}

/// Take back every planting in `gone` that no `kept` record shares, each path
/// once — and in an order that leaves a marker or an exclude line in place
/// until the last of what it covers has gone. Best-effort per planting: the
/// first failure is returned once the rest were tried.
fn take_back_all(gone: &[ArmRecord], kept: &[ArmRecord]) -> io::Result<()> {
    let mut failure = Ok(());
    for (index, record) in gone.iter().enumerate() {
        let shared = kept.iter().any(|r| r.at(&record.cwd, &record.path));
        let already = gone[..index].iter().any(|r| r.at(&record.cwd, &record.path));
        if shared || already {
            continue;
        }
        let rest: Vec<&ArmRecord> = kept
            .iter()
            .chain(gone[index + 1..].iter().filter(|r| !r.at(&record.cwd, &record.path)))
            .collect();
        if let Err(e) = take_back(record, &rest) {
            log::warn!("cwd arming: taking back {}/{} failed: {e}", record.cwd, record.path);
            if failure.is_ok() {
                failure = Err(e);
            }
        }
    }
    failure
}

/// A relative path's parts, or None when it is empty, absolute, or leaves
/// the directory.
fn relative_parts(path: &str) -> Option<Vec<String>> {
    let p = Path::new(path);
    if path.is_empty() || p.is_absolute() {
        return None;
    }
    let mut parts = Vec::new();
    for component in p.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    (!parts.is_empty()).then_some(parts)
}

/// Remove `dir` and its parents while they are empty, never `base` itself.
fn remove_empty_up_to(dir: &Path, base: &Path) {
    let mut at = Some(dir);
    while let Some(level) = at {
        if level == base || !level.starts_with(base) || fs::remove_dir(level).is_err() {
            break;
        }
        at = level.parent();
    }
}

fn exclude(base: &Path, segment: &str) {
    if let Err(e) = ensure_excluded(base, segment) {
        log::warn!("cwd arming: exclude line for {} failed: {e}", base.display());
    }
}

#[cfg(unix)]
fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::worktree_arm::test_support::fake_worktree;

    struct Scratch {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        cwd: PathBuf,
        plugin_dir: PathBuf,
        skills: PathBuf,
        base: PathBuf,
    }

    fn scratch() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let cwd = base.join("repo");
        fs::create_dir_all(&cwd).unwrap();
        let plugin_dir = base.join("home/plugin-workspaces/p.linker/ws-1");
        fs::create_dir_all(&plugin_dir).unwrap();
        let skills = base.join("home/skills/staging/ws-1/skills");
        fs::create_dir_all(&skills).unwrap();
        Scratch { root: base.join("home/cwd-arms"), cwd, plugin_dir, skills, base, _tmp: tmp }
    }

    impl Scratch {
        fn cwd(&self) -> String {
            self.cwd.to_string_lossy().into_owned()
        }
        fn allowed(&self) -> Vec<PathBuf> {
            vec![self.plugin_dir.clone(), self.skills.clone()]
        }
        fn arm(&self, plugin: &str, ws: &str, arms: &[CwdArm]) -> CwdArmReport {
            arm(&self.root, plugin, ws, &self.cwd(), arms, &self.allowed())
        }
        fn disarm(&self) -> Vec<String> {
            disarm(&self.root, &[self.cwd()], &[]).unwrap()
        }
    }

    fn file(path: &str, content: &str) -> CwdArm {
        CwdArm::File { path: path.into(), content: content.into() }
    }

    fn link(path: &str, target: &Path) -> CwdArm {
        CwdArm::Symlink { path: path.into(), target: target.to_string_lossy().into_owned() }
    }

    /// A second linked worktree of the same `main` repo `fake_worktree` makes.
    fn second_worktree(base: &Path) -> PathBuf {
        let gitdir = base.join("main/.git/worktrees/wt2");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let wt = base.join("wt2");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        wt
    }

    #[test]
    fn plants_a_file_beside_a_marker_and_rewrites_it_next_time() {
        let s = scratch();
        let report = s.arm("p.filer", "ws-1", &[file(".agent-conf/mcp.json", "{}")]);
        assert_eq!(report.armed, vec![".agent-conf/mcp.json"]);
        assert_eq!(fs::read_to_string(s.cwd.join(".agent-conf/mcp.json")).unwrap(), "{}");
        assert!(s.cwd.join(".agent-conf").join(MARKER_FILE).exists());
        let again = s.arm("p.filer", "ws-1", &[file(".agent-conf/mcp.json", "{\"a\":1}")]);
        assert!(again.refused.is_empty());
        assert_eq!(fs::read_to_string(s.cwd.join(".agent-conf/mcp.json")).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn a_file_of_the_users_is_never_written_over_nor_taken_back() {
        let s = scratch();
        fs::create_dir_all(s.cwd.join(".agent-conf")).unwrap();
        fs::write(s.cwd.join(".agent-conf/mcp.json"), "theirs").unwrap();
        let report = s.arm("p.filer", "ws-1", &[file(".agent-conf/mcp.json", "ours")]);
        assert!(report.armed.is_empty());
        assert_eq!(report.refused[0].reason, ".agent-conf/mcp.json here is not KeepDeck's");
        s.disarm();
        assert_eq!(fs::read_to_string(s.cwd.join(".agent-conf/mcp.json")).unwrap(), "theirs");
        assert!(!s.cwd.join(".agent-conf").join(MARKER_FILE).exists());
    }

    #[test]
    fn a_users_file_beside_our_marker_is_not_ours_without_a_record() {
        let s = scratch();
        s.arm("p.filer", "ws-1", &[file(".k/a", "ours")]);
        fs::write(s.cwd.join(".k/b"), "theirs").unwrap();
        let report = s.arm("p.filer", "ws-1", &[file(".k/a", "ours"), file(".k/b", "ours")]);
        assert_eq!(report.refused[0].reason, ".k/b here is not KeepDeck's");
        s.disarm();
        assert_eq!(fs::read_to_string(s.cwd.join(".k/b")).unwrap(), "theirs");
    }

    #[test]
    fn nothing_is_written_through_a_parent_that_is_a_file_or_a_link() {
        let s = scratch();
        fs::write(s.cwd.join(".agents"), "a file").unwrap();
        let report = s.arm("p.linker", "ws-1", &[link(".agents/skills", &s.skills)]);
        assert_eq!(report.refused[0].reason, ".agents here is not a directory");
        fs::remove_file(s.cwd.join(".agents")).unwrap();
        let elsewhere = s.base.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, s.cwd.join(".agents")).unwrap();
        let report = s.arm("p.linker", "ws-1", &[link(".agents/skills", &s.skills)]);
        assert_eq!(report.refused[0].reason, ".agents here is not a directory");
        assert!(fs::read_dir(&elsewhere).unwrap().next().is_none(), "nothing landed in their target");
    }

    #[test]
    fn a_link_points_only_into_the_plugins_own_directory_or_this_plans_skills() {
        let s = scratch();
        let ok = s.arm("p.linker", "ws-1", &[link(".agents/skills", &s.skills)]);
        assert_eq!(ok.armed, vec![".agents/skills"]);
        assert_eq!(fs::read_link(s.cwd.join(".agents/skills")).unwrap(), s.skills);
        let own = s.arm("p.linker", "ws-1", &[link(".agents/skills", &s.plugin_dir)]);
        assert!(own.refused.is_empty(), "{:?}", own.refused);
        let elsewhere = s.base.join("home/other");
        fs::create_dir_all(&elsewhere).unwrap();
        let out = s.arm("p.linker", "ws-1", &[link(".agents/skills", &elsewhere)]);
        assert_eq!(out.refused[0].reason, ".agents/skills would point outside what this agent may link to");
        // A refused re-declaration does not leave the old link standing for
        // the set it no longer is: it was ours, so it goes.
        assert!(fs::symlink_metadata(s.cwd.join(".agents/skills")).is_err());
    }

    #[test]
    fn a_link_cannot_leave_its_directory_by_dot_dot_by_a_link_or_by_not_existing_yet() {
        let s = scratch();
        let other = s.base.join("home/other");
        fs::create_dir_all(&other).unwrap();
        let through_link = s.skills.join("escape");
        std::os::unix::fs::symlink(&other, &through_link).unwrap();
        let targets = [
            // Lexically inside, really outside — and not even there.
            s.skills.join("../../../other/x"),
            // Inside, but spelled with `..`.
            s.skills.join("../skills"),
            // Inside the directory, a link that leads out of it.
            through_link,
            // Inside, but not there: nothing says where it will resolve.
            s.plugin_dir.join("later"),
        ];
        for target in targets {
            let report = s.arm("p.linker", "ws-1", &[link(".agents/skills", &target)]);
            assert_eq!(report.refused.len(), 1, "{}", target.display());
            assert!(fs::symlink_metadata(s.cwd.join(".agents/skills")).is_err(), "{}", target.display());
        }
    }

    #[test]
    fn a_link_is_made_to_the_real_location_of_its_target() {
        let s = scratch();
        let alias = s.base.join("alias");
        std::os::unix::fs::symlink(&s.skills, &alias).unwrap();
        let report = s.arm("p.linker", "ws-1", &[link(".agents/skills", &alias)]);
        assert!(report.refused.is_empty(), "{:?}", report.refused);
        assert_eq!(fs::read_link(s.cwd.join(".agents/skills")).unwrap(), s.skills);
    }

    #[test]
    fn a_link_or_directory_of_the_users_stays_as_it_is() {
        let s = scratch();
        fs::create_dir_all(s.cwd.join(".agents/skills")).unwrap();
        let theirs = s.arm("p.linker", "ws-1", &[link(".agents/skills", &s.skills)]);
        assert_eq!(theirs.refused[0].reason, ".agents/skills is your own — nothing was planted");
        fs::remove_dir(s.cwd.join(".agents/skills")).unwrap();
        let elsewhere = s.base.join("theirs");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, s.cwd.join(".agents/skills")).unwrap();
        let foreign = s.arm("p.linker", "ws-1", &[link(".agents/skills", &s.skills)]);
        assert_eq!(foreign.refused[0].reason, ".agents/skills points somewhere else — it is not ours to replace");
        assert_eq!(fs::read_link(s.cwd.join(".agents/skills")).unwrap(), elsewhere);
    }

    #[test]
    fn a_users_link_to_the_very_same_place_is_still_theirs() {
        let s = scratch();
        fs::create_dir_all(s.cwd.join(".agents")).unwrap();
        std::os::unix::fs::symlink(&s.skills, s.cwd.join(".agents/skills")).unwrap();
        let report = s.arm("p.linker", "ws-1", &[link(".agents/skills", &s.skills)]);
        assert_eq!(report.refused[0].reason, ".agents/skills is your own — nothing was planted");
        s.disarm();
        assert_eq!(fs::read_link(s.cwd.join(".agents/skills")).unwrap(), s.skills);
    }

    #[test]
    fn one_path_belongs_to_one_plugin() {
        let s = scratch();
        s.arm("p.filer", "ws-1", &[file(".x/conf", "a")]);
        let second = s.arm("p.other", "ws-2", &[file(".x/conf", "b")]);
        assert_eq!(second.refused[0].reason, ".x/conf is planted here by another agent");
        assert_eq!(fs::read_to_string(s.cwd.join(".x/conf")).unwrap(), "a");
    }

    #[test]
    fn two_spellings_of_one_name_are_one_path() {
        let s = scratch();
        s.arm("p.filer", "ws-1", &[file(".x/mcp.json", "a")]);
        let second = s.arm("p.other", "ws-2", &[file(".x/MCP.json", "b")]);
        assert_eq!(second.refused[0].reason, ".x/MCP.json is planted here by another agent");
        assert_eq!(fs::read_to_string(s.cwd.join(".x/mcp.json")).unwrap(), "a");
        let twice = s.arm("p.filer", "ws-1", &[file(".y/a", "1"), file(".y/A", "2")]);
        assert_eq!(twice.refused[0].reason, ".y/A is declared twice");
    }

    #[test]
    fn a_path_that_leaves_the_directory_is_refused() {
        let s = scratch();
        for path in ["../escape", "/abs", "", "a/../../b"] {
            let report = s.arm("p.filer", "ws-1", &[file(path, "x")]);
            assert_eq!(report.refused.len(), 1, "{path:?}");
        }
        assert!(!s.base.join("escape").exists());
    }

    #[test]
    fn a_gone_directory_refuses_without_planting() {
        let s = scratch();
        fs::remove_dir_all(&s.cwd).unwrap();
        let report = s.arm("p.filer", "ws-1", &[file(".k/c", "x")]);
        assert_eq!(report.refused[0].reason, "this directory no longer exists");
        assert!(!s.cwd.exists());
    }

    #[test]
    fn the_set_is_complete_what_is_no_longer_declared_is_taken_back() {
        let s = scratch();
        s.arm("p.filer", "ws-1", &[file(".k/a", "1"), file(".k/b", "2")]);
        s.arm("p.filer", "ws-1", &[file(".k/a", "1")]);
        assert!(!s.cwd.join(".k/b").exists());
        assert!(s.cwd.join(".k").join(MARKER_FILE).exists(), "a is still ours beside it");
        let none = s.arm("p.filer", "ws-1", &[]);
        assert!(none.armed.is_empty() && none.refused.is_empty());
        assert!(!s.cwd.join(".k").exists(), "nothing of ours is left, not even the directory");
        assert!(!manifest(&s.root, "ws-1").exists());
    }

    #[test]
    fn git_is_blind_to_what_was_planted_until_nothing_is_left() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let exclude = s.base.join("main/.git/info/exclude");
        let cwd = wt.to_string_lossy().into_owned();
        arm(&s.root, "p.filer", "ws-1", &cwd, &[file(".agent-conf/mcp.json", "{}")], &s.allowed());
        assert_eq!(fs::read_to_string(&exclude).unwrap().matches("/.agent-conf/").count(), 1);
        arm(&s.root, "p.filer", "ws-1", &cwd, &[], &s.allowed());
        assert!(!fs::read_to_string(&exclude).unwrap_or_default().contains(".agent-conf"));
    }

    #[test]
    fn the_line_two_worktrees_of_one_repo_share_goes_with_the_last_planting() {
        let s = scratch();
        let (one, two) = (fake_worktree(&s.base), second_worktree(&s.base));
        let exclude = s.base.join("main/.git/info/exclude");
        let planting = [file(".agent-conf/mcp.json", "{}")];
        for wt in [&one, &two] {
            arm(&s.root, "p.filer", "ws-1", &wt.to_string_lossy(), &planting, &s.allowed());
        }
        disarm(&s.root, &[one.to_string_lossy().into_owned()], &[]).unwrap();
        assert!(fs::read_to_string(&exclude).unwrap().contains("/.agent-conf/"), "the other still needs it");
        disarm(&s.root, &[two.to_string_lossy().into_owned()], &[]).unwrap();
        assert!(!fs::read_to_string(&exclude).unwrap().contains("/.agent-conf/"));
    }

    #[test]
    fn a_lost_marker_leaves_the_file_but_not_our_exclude_line() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let exclude = s.base.join("main/.git/info/exclude");
        let cwd = wt.to_string_lossy().into_owned();
        arm(&s.root, "p.filer", "ws-1", &cwd, &[file(".agent-conf/mcp.json", "{}")], &s.allowed());
        fs::remove_file(wt.join(".agent-conf").join(MARKER_FILE)).unwrap();
        disarm(&s.root, &[cwd], &[]).unwrap();
        assert!(wt.join(".agent-conf/mcp.json").exists(), "no longer provably ours");
        assert!(!fs::read_to_string(&exclude).unwrap().contains("/.agent-conf/"));
    }

    #[test]
    fn disarm_takes_back_every_plugins_planting_in_those_cwds() {
        let s = scratch();
        s.arm("p.filer", "ws-1", &[file(".agent-conf/mcp.json", "{}")]);
        s.arm("p.linker", "ws-1", &[link(".agents/skills", &s.skills)]);
        assert_eq!(s.disarm(), vec![s.cwd()]);
        assert!(!s.cwd.join(".agent-conf").exists());
        assert!(!s.cwd.join(".agents").exists());
        assert!(s.skills.exists(), "a link goes as a link");
        assert!(!manifest(&s.root, "ws-1").exists());
    }

    #[test]
    fn disarm_leaves_a_root_a_live_workspace_still_is_however_it_is_spelled() {
        let s = scratch();
        s.arm("p.filer", "ws-1", &[file(".agent-conf/mcp.json", "{}")]);
        let alias = s.base.join("alias");
        std::os::unix::fs::symlink(&s.cwd, &alias).unwrap();
        let live = [alias.to_string_lossy().into_owned()];
        let released = disarm(&s.root, &[s.cwd()], &live).unwrap();
        assert!(released.is_empty());
        assert!(s.cwd.join(".agent-conf/mcp.json").exists());
        // Armed through one spelling, disarmed through another: one cwd.
        let dotted = format!("{}/../repo", s.cwd());
        assert_eq!(disarm(&s.root, &[dotted.clone()], &[]).unwrap(), vec![dotted]);
        assert!(!s.cwd.join(".agent-conf").exists());
    }

    #[test]
    fn a_directory_two_workspaces_share_loses_a_planting_only_with_its_last_record() {
        let s = scratch();
        s.arm("p.filer", "ws-1", &[file(".agent-conf/mcp.json", "{}")]);
        s.arm("p.filer", "ws-2", &[file(".agent-conf/mcp.json", "{}")]);
        prune(&s.root, &["ws-2".into()]).unwrap();
        assert!(s.cwd.join(".agent-conf/mcp.json").exists(), "ws-2 still records it");
        assert!(!manifest(&s.root, "ws-1").exists());
        prune(&s.root, &[]).unwrap();
        assert!(!s.cwd.join(".agent-conf").exists());
    }

    #[test]
    fn an_unreadable_record_is_never_written_over_and_stops_what_could_be_its_own() {
        let s = scratch();
        fs::create_dir_all(&s.root).unwrap();
        fs::write(manifest(&s.root, "ws-1"), "not json").unwrap();
        let report = s.arm("p.filer", "ws-1", &[file(".k/c", "x")]);
        assert_eq!(report.refused.len(), 1);
        s.arm("p.filer", "ws-2", &[file(".k/c", "x")]);
        // ws-1 is live and might record .k/c too: nothing is swept or disarmed.
        prune(&s.root, &["ws-1".into()]).unwrap();
        assert!(disarm(&s.root, &[s.cwd()], &[]).is_err());
        assert!(s.cwd.join(".k/c").exists());
        // Once ws-1 is gone its record is set aside, never deleted.
        prune(&s.root, &["ws-2".into()]).unwrap();
        assert_eq!(fs::read_to_string(s.root.join("ws-1.json.unreadable")).unwrap(), "not json");
        assert!(!manifest(&s.root, "ws-1").exists());
    }

    #[test]
    fn a_refused_write_leaves_no_claim_behind() {
        let s = scratch();
        // The target is a directory: the write fails, and the marker this
        // call would have made is not left claiming it.
        fs::create_dir_all(s.cwd.join(".k/c")).unwrap();
        let report = s.arm("p.filer", "ws-1", &[file(".k/c", "x")]);
        assert_eq!(report.refused[0].reason, ".k/c here is not KeepDeck's");
        assert!(!s.cwd.join(".k").join(MARKER_FILE).exists());
        assert!(!manifest(&s.root, "ws-1").exists(), "nor a record of it");
    }

    #[test]
    fn what_is_recorded_answers_for_the_retirement_of_older_plantings() {
        let s = scratch();
        s.arm("p.filer", "ws-1", &[file(".agent-conf/mcp.json", "{}")]);
        assert!(recorded_at(&s.root, &s.cwd, ".agent-conf/mcp.json").unwrap());
        assert!(!recorded_at(&s.root, &s.cwd, ".agents/skills").unwrap());
        fs::write(manifest(&s.root, "ws-9"), "not json").unwrap();
        assert!(recorded_at(&s.root, &s.cwd, ".agents/skills").is_err());
    }
}
