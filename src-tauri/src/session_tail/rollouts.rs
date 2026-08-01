//! Codex rollout discovery on disk — not tailing: the boot catch-up sweep
//! and the TUI-resume fallback resolver both walk the day-partitioned
//! `~/.codex/sessions/YYYY/MM/DD/` tree cold.

use std::cmp::Reverse;
use std::path::PathBuf;

use serde_json::Value;

use super::dialects::{last_of_each, SourceTimestamp, TailFormat};
use super::reader::{drain_file, TailCursor};

/// Every `rollout-*.jsonl` under the sessions tree, newest mtime first.
fn rollouts_newest_first(root: &std::path::Path) -> Vec<(std::time::SystemTime, PathBuf)> {
    let mut found = Vec::new();
    let days = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|y| std::fs::read_dir(y.path()).into_iter().flatten().flatten())
        .flat_map(|m| std::fs::read_dir(m.path()).into_iter().flatten().flatten());
    for day in days {
        let Ok(files) = std::fs::read_dir(day.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let is_rollout = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"));
            if !is_rollout {
                continue;
            }
            let modified = file
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            found.push((modified, path));
        }
    }
    found.sort_by_key(|(modified, _)| Reverse(*modified));
    found
}

/// Locate a codex session's rollout by its recorded id — the fallback for
/// TUI resumes: codex (observed on 0.144.5) fires SessionStart in `exec`
/// and `exec resume` but NOT in the interactive `resume`, so no binding
/// carries the path. Rollout names end `-<session_id>.jsonl`; the newest
/// match wins.
pub(super) fn find_rollout_in(root: &std::path::Path, session_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{session_id}.jsonl");
    rollouts_newest_first(root)
        .into_iter()
        .map(|(_, path)| path)
        .find(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(&suffix))
        })
}

/// The last usage event of the newest rollout on disk, its source time and
/// that FILE's mtime fallback. This is the boot catch-up: codex runs outside
/// KeepDeck too, so its sessions dir can know fresher limits than cache.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRollout {
    pub(super) event: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source_at: Option<SourceTimestamp>,
    pub(super) mtime_ms: u64,
}

/// A just-launched session writes its rollout before any turn, so the
/// newest file may carry no usage while an older one holds the account's
/// real last word — walk newest-first until a `token_count` shows up, but
/// never scan an unbounded history for an account that has none.
const BOOT_SWEEP_MAX_FILES: usize = 10;

pub(super) fn latest_rollout_usage_in(root: &std::path::Path) -> Option<LatestRollout> {
    let files = rollouts_newest_first(root);
    for (modified, path) in files.into_iter().take(BOOT_SWEEP_MAX_FILES) {
        // A cold read needs no TailState — one cursor from offset zero.
        let mut cursor = TailCursor::default();
        let (events, _) = drain_file(&path, &mut cursor, TailFormat::Codex);
        let event = last_of_each(events, TailFormat::Codex.catch_up_order())
            .into_iter()
            .find(|e| e.payload.get("type").and_then(|t| t.as_str()) == Some("token_count"));
        if let Some(event) = event {
            let mtime_ms = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            return Some(LatestRollout {
                event: event.payload,
                source_at: event.source_at,
                mtime_ms,
            });
        }
    }
    None
}

/// The boot catch-up: the newest on-disk usage event. The event rides
/// verbatim (payloads are opaque to Rust); source time (or mtime), never
/// receipt time, is its honest age.
pub(super) fn latest_codex_rollout() -> Option<LatestRollout> {
    let home = std::env::var_os("HOME")?;
    latest_rollout_usage_in(&PathBuf::from(home).join(".codex/sessions"))
}

/// The fallback resolver. The id is sanitized to uuid characters — it names
/// a file suffix, nothing else may ride in.
pub(super) fn find_codex_rollout(session_id: &str) -> Option<String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    let root = PathBuf::from(home).join(".codex/sessions");
    find_rollout_in(&root, session_id).map(|p| p.to_string_lossy().into_owned())
}
