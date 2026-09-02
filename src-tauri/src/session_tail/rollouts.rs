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

// Locating a rollout BY SESSION ID lived here, for the TUI resume where
// codex fires no SessionStart and no binding carries a path. It is the
// plugin's now — the same walk its history browser already does — so this
// file is left with the one job that is genuinely the host's: the boot
// sweep, which wants the newest rollout on disk and does not care whose.

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

fn latest_rollout_usage_in(root: &std::path::Path) -> Option<LatestRollout> {
    let files = rollouts_newest_first(root);
    for (modified, path) in files.into_iter().take(BOOT_SWEEP_MAX_FILES) {
        // A cold read needs no TailState — one cursor from offset zero.
        let mut cursor = TailCursor::default();
        // No watch here: this is the boot sweep over a COLD store, and what
        // it wants is the last of each usage kind. Carrying records for a
        // dialect would replay a finished session's edges as if fresh.
        let (events, _) = drain_file(&path, &mut cursor, TailFormat::Codex, &[]);
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

/// Codex's day-partitioned session store. `None` (no HOME) fails as a
/// quiet "nothing found" at both call sites — a pane just stays unbound.
fn codex_sessions_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".codex/sessions"))
}

/// The boot catch-up: the newest on-disk usage event. The event rides
/// verbatim (payloads are opaque to Rust); source time (or mtime), never
/// receipt time, is its honest age.
pub(super) fn latest_codex_rollout() -> Option<LatestRollout> {
    latest_rollout_usage_in(&codex_sessions_root()?)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::super::dialects::SourceTimestamp;
    use super::super::test_support::*;
    use super::*;

    // The by-session-id search this file used to hold is tested where it now
    // lives — in codex's own plugin, over its own store description.

    #[test]
    fn boot_sweep_returns_the_newest_rollout_that_carries_usage() {
        let root = temp_dir();
        let day = root.join("2026/07/19");
        fs::create_dir_all(&day).unwrap();

        // Oldest: real usage. Newer: usage with a distinct marker. Newest:
        // a fresh session with no token_count yet — must be walked past.
        let oldest = day.join("rollout-2026-07-19T01-00-00-aaaa.jsonl");
        fs::write(&oldest, format!("{TOKEN_COUNT_LINE}\n")).unwrap();
        set_mtime(&oldest, 1_000);
        let with_usage = day.join("rollout-2026-07-19T02-00-00-bbbb.jsonl");
        let marked = TOKEN_COUNT_LINE.replace("75.0", "33.0");
        fs::write(&with_usage, format!("{TURN_CONTEXT_LINE}\n{marked}\n")).unwrap();
        set_mtime(&with_usage, 2_000);
        let empty_of_usage = day.join("rollout-2026-07-19T03-00-00-cccc.jsonl");
        fs::write(&empty_of_usage, format!("{TURN_CONTEXT_LINE}\n")).unwrap();
        set_mtime(&empty_of_usage, 3_000);

        let found = latest_rollout_usage_in(&root).expect("usage found");
        assert_eq!(found.event["type"], "token_count");
        assert_eq!(found.event["rate_limits"]["primary"]["used_percent"], 33.0);
        assert_eq!(
            found.source_at,
            Some(SourceTimestamp::Iso(SOURCE_ISO.into()))
        );
        assert_eq!(found.mtime_ms, 2_000_000, "stamped with the FILE's age");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn boot_sweep_finds_nothing_in_an_empty_or_usage_free_tree() {
        let root = temp_dir();
        assert_eq!(latest_rollout_usage_in(&root), None);

        let day = root.join("2026/07/19");
        fs::create_dir_all(&day).unwrap();
        fs::write(
            day.join("rollout-2026-07-19T01-00-00-aaaa.jsonl"),
            format!("{TURN_CONTEXT_LINE}\n"),
        )
        .unwrap();
        // Non-rollout siblings never count as sessions.
        fs::write(day.join("notes.jsonl"), format!("{TOKEN_COUNT_LINE}\n")).unwrap();
        assert_eq!(latest_rollout_usage_in(&root), None);

        fs::remove_dir_all(&root).ok();
    }
}
