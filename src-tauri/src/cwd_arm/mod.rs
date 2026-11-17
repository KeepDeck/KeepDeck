//! Arming a pane's working directory with what an agent's plugin declares
//! (`AgentHooks["arm.plan"]`, plugin API 72): a file, or a symlink, at a path
//! relative to the cwd — for a CLI whose only door for something is a place
//! in the directory it starts in.
//!
//! The PLUGIN says what is planted; this engine owns everything that makes
//! planting in a user's directory safe, the same for every agent. The
//! guarantee: whatever happens, a crash at any point included, nothing of the
//! user's is written over, moved or removed.
//!
//! - What is ours is read from the disk, every time ([`proof`]): a link by
//!   where it points — into the plugin's own directories of its workspace —
//!   and a file by being exactly the file KeepDeck landed, entry and bytes.
//!   A record ([`registry`]) only says where to look. Anything not provably
//!   ours is left as it is, and said: a file an older build recorded without
//!   a receipt too.
//! - Nothing is planted or taken back through a folder on the way that is a
//!   file or a link ([`disk`]): every change goes through the open folder it
//!   happens in, and only into an empty name, or over what is provably ours.
//!   The one link on the way that gives way is the one older builds made to
//!   codex's whole skills folder.
//! - Every planting is recorded before it is made, a file as prepared until
//!   it is seen in place, so a crash leaves a record that settles from what
//!   stands, never a planting no record names.
//! - Git is kept blind to exactly what is planted, never to the user's files
//!   beside it ([`lines`]), from before it is published.
//! - While any workspace's record will not read, nothing that stands is
//!   changed or taken back: that record could be the claim on it.
//! - One path in one directory belongs to one plugin; a path is the entry it
//!   names, not its spelling. Two workspaces sharing a directory plant there
//!   side by side, so an agent started in it sees both sets.
//!
//! Not covered, by design: someone editing the very entry, or a folder on
//! its way, during the moment of a pass; and two KeepDeck homes changing one
//! repo's exclude file at the same time.
//!
//! Each `arm` call speaks for ONE plugin in ONE directory, and for its whole
//! set there: what it no longer declares is taken back. The host orders every
//! call against worktree teardown; the lock here only keeps two calls from
//! interleaving.

mod disk;
mod lifecycle;
mod lines;
mod proof;
mod registry;
#[cfg(test)]
mod tests;

use std::collections::BTreeSet;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

use registry::{canonical, Held, Ledger, Place, What};

/// One pass at a time.
static LOCK: Mutex<()> = Mutex::new(());

/// How much one arming may plant, in UTF-8 bytes — the contract's `ARM_CAPS`
/// (plugin API 73; 256 entries since 84, room for a link per shared skill),
/// read from `armCaps.json`, the one file the plugin API reads it from too.
/// The first `entries_max` entries are planted and each one past them is
/// refused; a set past the content total is refused whole; one entry past its
/// own cap alone.
#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
struct ArmCaps {
    entries_max: usize,
    path_max_bytes: usize,
    target_max_bytes: usize,
    content_max_bytes: usize,
    total_content_max_bytes: usize,
}

static CAPS: LazyLock<ArmCaps> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../packages/plugin-api/src/context/armCaps.json"))
        .expect("the plugin API's armCaps.json reads as the arm caps")
});

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
/// A link may point into the plugin's own workspace directory or the plan's
/// `skills_dir`.
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
    let home = home()?;
    let mut allowed = vec![home.join("plugin-workspaces").join(&plugin_id).join(&ws_id)];
    allowed.extend(skills_dir.map(PathBuf::from));
    let _guard = lock();
    Ok(lifecycle::arm(&records_root(&home), &home, &plugin_id, &ws_id, &cwd, &arms, &allowed))
}

/// Take back everything planted in these cwds, for every plugin and
/// workspace — except in a cwd one of `live_roots` still is. Returns the cwds
/// released, as asked for.
#[tauri::command(async)]
pub fn cwd_disarm(roots: Vec<String>, live_roots: Vec<String>) -> Result<Vec<String>, String> {
    let home = home()?;
    let _guard = lock();
    disarm(&records_root(&home), &home, &roots, &live_roots).map_err(|e| e.to_string())
}

/// Sweep what workspaces that no longer exist planted — the crash path.
#[tauri::command(async)]
pub fn cwd_arm_prune(live_ws_ids: Vec<String>) -> Result<(), String> {
    let home = home()?;
    let _guard = lock();
    prune(&records_root(&home), &home, &live_ws_ids).map_err(|e| e.to_string())
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// KeepDeck's home, real path: links are judged against directories in it.
fn home() -> Result<PathBuf, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for cwd arming")?;
    Ok(std::fs::canonicalize(&home).unwrap_or(home))
}

/// Where the per-workspace records live under KeepDeck's home.
pub(crate) fn records_root(home: &Path) -> PathBuf {
    home.join("cwd-arms")
}

/// Whether any workspace records `path` in `cwd` — asked by the retirement of
/// what older builds planted, so it never takes back what this engine manages
/// at the same place. An unreadable record answers with an error: it may.
pub(crate) fn recorded_at(root: &Path, cwd: &Path, path: &str) -> io::Result<bool> {
    let _guard = lock();
    let ledger = Ledger::read(root)?;
    whole(&ledger)?;
    let cwd = canonical(&cwd.to_string_lossy());
    let recorded = ledger.all().any(|(_, place)| place.at(&cwd, path));
    Ok(recorded)
}

/// An error naming the record that will not read, when one will not.
fn whole(ledger: &Ledger) -> io::Result<()> {
    match ledger.unreadable.first() {
        Some(ws) => Err(io::Error::other(format!("the record of {ws} is unreadable — nothing was taken back"))),
        None => Ok(()),
    }
}

/// Take back what was planted in `roots`, except in a root one of `live` still
/// is, however either is spelled. Returns the roots released, spelled as
/// asked — or an error naming what could not be taken back, which stays
/// recorded so the next disarm or prune tries it again.
fn disarm(root: &Path, home: &Path, roots: &[String], live: &[String]) -> io::Result<Vec<String>> {
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
    let mut ledger = Ledger::read(root)?;
    whole(&ledger)?;
    let failed = sweep(&mut ledger, home, |_, place| gone_roots.contains(&place.cwd))?;
    if failed.is_empty() {
        Ok(released)
    } else {
        Err(io::Error::other(format!("could not take back {}", plantings(&failed))))
    }
}

/// Dead workspaces' plantings go. A dead workspace's unreadable record is set
/// aside (its plantings stay where they are, unclaimed); while a LIVE one's
/// will not read, nothing goes.
fn prune(root: &Path, home: &Path, live: &[String]) -> io::Result<()> {
    let mut ledger = Ledger::read(root)?;
    for ws in ledger.unreadable.iter().filter(|ws| !live.contains(ws)) {
        if let Err(e) = ledger.set_aside(ws) {
            log::warn!("cwd arming: setting the unreadable record of {ws} aside failed: {e}");
        }
    }
    if let Some(ws) = ledger.unreadable.iter().find(|ws| live.contains(ws)) {
        log::warn!("cwd arming: the record of live {ws} is unreadable — nothing swept");
        return Ok(());
    }
    ledger.unreadable.clear();
    let failed = sweep(&mut ledger, home, |ws, _| !live.iter().any(|id| id == ws))?;
    if !failed.is_empty() {
        log::warn!("cwd arming: sweeping dead workspaces left {}", plantings(&failed));
    }
    Ok(())
}

/// Retire every place `gone` picks, across workspaces, through the one
/// lifecycle: plantings first, then the folders made for them, then the lines
/// nothing needs any more. Each workspace's record keeps what would not go.
fn sweep(ledger: &mut Ledger, home: &Path, gone: impl Fn(&str, &Place) -> bool) -> io::Result<Vec<Place>> {
    let mut leaving: Vec<Held> = Vec::new();
    let mut staying: Vec<Held> = Vec::new();
    for (ws, place) in ledger.all() {
        let entry = (ws.to_string(), place.clone());
        if gone(ws, place) {
            leaving.push(entry);
        } else {
            staying.push(entry);
        }
    }
    if leaving.is_empty() {
        return Ok(Vec::new());
    }
    let (dirs, plantings): (Vec<Held>, Vec<Held>) =
        leaving.into_iter().partition(|(_, p)| matches!(p.what, What::Dir { .. }));
    let lifecycle::Outcome { mut released, mut retained } = lifecycle::retire(home, true, plantings);
    let present: Vec<Place> = staying.iter().chain(&retained).map(|(_, p)| p.clone()).collect();
    let dirs_out = lifecycle::retire_dirs(true, dirs, &present);
    released.extend(dirs_out.released);
    retained.extend(dirs_out.retained);
    let remaining: Vec<&Place> = staying.iter().chain(&retained).map(|(_, p)| p).collect();
    let still = lines::Lines::default().release(&released, &remaining);
    retained.extend(still);
    let workspaces: BTreeSet<String> = ledger.places.iter().map(|(ws, _)| ws.clone()).collect();
    for ws in workspaces {
        let places: Vec<Place> =
            staying.iter().chain(&retained).filter(|(id, _)| *id == ws).map(|(_, p)| p.clone()).collect();
        ledger.write(&ws, places)?;
    }
    Ok(retained.into_iter().map(|(_, p)| p).collect())
}

/// The plantings in `places`, for a message: `cwd/path`, comma-separated.
fn plantings(places: &[Place]) -> String {
    places.iter().map(|p| format!("{}/{}", p.cwd, p.path)).collect::<Vec<_>>().join(", ")
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
