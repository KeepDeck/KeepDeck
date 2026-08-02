//! What KeepDeck plants inside a pane's working directory, and how it is
//! taken back.
//!
//! Two features arm directories: shared skills put a `.agents/skills` symlink
//! where codex looks, and the MCP injection puts a `.kimi-code/mcp.json` where
//! kimi looks. Neither CLI has a flag, so the filesystem IS the delivery — and
//! both then owe the same three duties, which live here so they cannot drift
//! apart:
//!
//! - keep git blind to what was planted (`info/exclude` in the owning repo,
//!   anchored to the exact directory);
//! - remember which cwds were armed, so a workspace that dies in a CRASH can
//!   still be disarmed at the next boot — the deck no longer knows those
//!   directories, this manifest does;
//! - spare a cwd another workspace still claims, because two workspaces may
//!   legitimately run panes in one folder.
//!
//! What is planted, and how "provably ours" is decided, stays with each
//! feature: a symlink into KeepDeck's home is recognisable one way, a JSON
//! file another.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use crate::state::write_atomic;

/// Where one key's armed cwds are remembered. The key is the workspace id:
/// arming is per pane cwd, but a workspace is what dies, and what a boot
/// sweep is given the live set of.
pub(crate) fn armed_manifest(root: &Path, key: &str) -> PathBuf {
    root.join("armed").join(key)
}

/// The recorded armed cwds of one key (empty when absent/unreadable).
pub(crate) fn manifest_roots(root: &Path, key: &str) -> Vec<String> {
    fs::read(armed_manifest(root, key))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Every cwd some OTHER key still claims.
pub(crate) fn claimed_by_others(root: &Path, except: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root.join("armed")) else {
        return Vec::new();
    };
    let mut claimed = Vec::new();
    for entry in entries.flatten() {
        let key = entry.file_name().to_string_lossy().into_owned();
        if key == except {
            continue;
        }
        claimed.extend(manifest_roots(root, &key));
    }
    claimed
}

/// Record what a key has armed, REPLACING what was recorded before.
///
/// The caller must speak for the key's WHOLE set — this is the shape a
/// staging pass has, where every one of a workspace's roots is armed (or
/// deliberately not) in one call. A caller that speaks for a single cwd must
/// use [`add_armed`] instead, or it erases the cwds it did not mention.
///
/// An empty set drops the manifest: nothing is armed, so nothing is owed a
/// sweep.
pub(crate) fn record_armed(root: &Path, key: &str, armed: &[String], what: &str) {
    let path = armed_manifest(root, key);
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
        log::warn!("{what}: recording armed cwds for {key} failed: {e}");
    }
}

/// Add to what a key has armed, keeping every cwd already recorded.
///
/// For callers that arrive ONE cwd at a time — a pane spawning is such a
/// caller, and it knows nothing about its workspace's other panes. Replacing
/// there would erase the record of every earlier pane, and a pass that armed
/// nothing would delete the manifest outright, orphaning what those panes
/// planted: files, markers and `info/exclude` lines that only this record can
/// find again after a crash.
pub(crate) fn add_armed(root: &Path, key: &str, armed: &[String], what: &str) {
    if armed.is_empty() {
        return;
    }
    let mut recorded = manifest_roots(root, key);
    for cwd in armed {
        if !recorded.contains(cwd) {
            recorded.push(cwd.clone());
        }
    }
    record_armed(root, key, &recorded, what);
}

/// Drop `cwds` from every key's manifest — the other half of [`add_armed`].
///
/// A per-cwd caller cannot name the key it recorded under: a disarm is handed
/// DIRECTORIES, and one directory may have been armed by any workspace. So
/// every manifest is rewritten without them, and one that ends up empty is
/// dropped by [`record_armed`].
///
/// Without this the record only ever GROWS. It would keep naming cwds that
/// were disarmed long ago, and [`claimed_by_others`] would then spare a dead
/// workspace's real arming on the strength of that stale claim — leaving a
/// planted file, its marker and its `info/exclude` line with nothing left
/// pointing at them.
pub(crate) fn forget_armed(root: &Path, cwds: &[String], what: &str) {
    if cwds.is_empty() {
        return;
    }
    let Ok(entries) = fs::read_dir(root.join("armed")) else {
        return;
    };
    for entry in entries.flatten() {
        let key = entry.file_name().to_string_lossy().into_owned();
        let recorded = manifest_roots(root, &key);
        let kept: Vec<String> = recorded
            .iter()
            .filter(|cwd| !cwds.contains(cwd))
            .cloned()
            .collect();
        if kept.len() != recorded.len() {
            record_armed(root, &key, &kept, what);
        }
    }
}

/// Sweep the manifests of keys that are no longer live, handing each dead
/// key's cwds to `disarm` — minus any cwd a surviving key still claims, so a
/// shared folder does not lose its arming because one workspace died.
///
/// A manifest that will not parse is EVIDENCE of armed cwds we can no longer
/// locate: it is kept (and warned about) rather than deleted, so a later
/// fixed pass can still act on it.
pub(crate) fn prune_manifests(
    root: &Path,
    live: &[String],
    what: &str,
    disarm: impl Fn(&[String]) -> io::Result<()>,
) -> io::Result<()> {
    let manifests = match fs::read_dir(root.join("armed")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in manifests.flatten() {
        let key = entry.file_name().to_string_lossy().into_owned();
        if live.iter().any(|l| l == &key) {
            continue;
        }
        let Some(roots) = fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        else {
            log::warn!("{what}: armed manifest for {key} is unreadable — kept, not disarmed");
            continue;
        };
        let claimed = claimed_by_others(root, &key);
        let ours: Vec<String> = roots.into_iter().filter(|r| !claimed.contains(r)).collect();
        if let Err(e) = disarm(&ours) {
            log::warn!("{what}: disarming dead workspace {key} failed: {e}");
        }
        let _ = fs::remove_file(entry.path());
    }
    Ok(())
}

/// Idempotently append the armed directory's anchored line to the owning
/// repo's SHARED `info/exclude`, so what was planted never shows up in git
/// status or a commit. A cwd outside any checkout simply has nowhere to write
/// and is left alone.
pub(crate) fn ensure_excluded(armed_root: &Path, planted: &str) -> io::Result<()> {
    match exclusion(armed_root, planted)? {
        Some((common_dir, line)) => keepdeck_git::exclude::ensure_line(&common_dir, &line),
        None => Ok(()),
    }
}

/// Remove the exact line arming appended — nothing else in the user's exclude
/// file is touched (byte-faithful removal lives in `keepdeck_git::exclude`).
pub(crate) fn remove_excluded(armed_root: &Path, planted: &str) -> io::Result<()> {
    match exclusion(armed_root, planted)? {
        Some((common_dir, line)) => keepdeck_git::exclude::remove_line(&common_dir, &line),
        None => Ok(()),
    }
}

/// The owning repo's COMMON git dir plus the anchored ignore pattern for an
/// armed cwd — `/<planted>/` at the repo root, `/<subdir>/<planted>/` below
/// it (forward slashes on every platform: the pattern is git syntax) — or
/// `None` when no ancestor is a git checkout.
fn exclusion(armed_root: &Path, planted: &str) -> io::Result<Option<(PathBuf, String)>> {
    let Some(repo) = keepdeck_git::exclude::owning_repo(armed_root)? else {
        return Ok(None);
    };
    let line = if repo.below_root.is_empty() {
        format!("/{planted}/")
    } else {
        format!("/{}/{planted}/", repo.below_root)
    };
    Ok(Some((repo.common_dir, line)))
}
