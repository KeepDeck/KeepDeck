//! Bringing the old `usage-history.jsonl` into the store, once.
//!
//! Every line is replayed through the same record path a live report takes:
//! its cumulative observation is the report, and each counter starts from
//! where it stood before the line it first appears in. So the import books exactly
//! what the file booked — except where the file was wrong, which the record
//! path now corrects the same way it does live: a provider's recount dip is
//! no longer counted as a reset, and a call reported in two halves becomes
//! one event.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::model::{
    CaptureContext, Observation, SessionOrigin, TokenCounts, UsageReport, Worktree, TOKEN_KINDS,
};
use crate::store::{record_in, UsageStore};

/// The schema of the lines this import reads.
const LINE_SCHEMA: u64 = 2;

/// Lines per transaction: big enough that the import is not one commit per
/// line, small enough that a crash mid-import loses little of the work.
const BATCH_LINES: usize = 10_000;

/// What an import did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportReport {
    pub lines: u64,
    /// Lines of a newer schema, left out; the store says it is incomplete.
    pub withheld: u64,
    /// Lines this build cannot read at all (torn, older schema, malformed).
    pub skipped: u64,
    /// Where the file was moved once imported.
    pub kept_as: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    schema_version: u64,
    agent: String,
    #[serde(default)]
    model: Option<String>,
    workspace_id: String,
    workspace_name: String,
    workspace_cwd: String,
    pane_id: String,
    pane_name: String,
    session_id: String,
    #[serde(default)]
    worktree: Option<Worktree>,
    occurred_at: f64,
    captured_at: f64,
    #[serde(default)]
    tokens: TokenCounts,
    #[serde(default)]
    cost_usd: Option<f64>,
    observation: Observation,
}

/// The base a line's delta was taken against: its observation minus what it
/// booked.
fn base_before(line: &Line) -> Observation {
    let mut tokens = TokenCounts::default();
    for kind in TOKEN_KINDS {
        if let Some(seen) = line.observation.tokens.get(kind) {
            let booked = line.tokens.get(kind).unwrap_or(0.0);
            tokens.set(kind, Some((seen - booked).max(0.0)));
        }
    }
    let cost_usd = line
        .observation
        .cost_usd
        .map(|seen| (seen - line.cost_usd.unwrap_or(0.0)).max(0.0));
    Observation { tokens, cost_usd }
}

/// Import `path` into `store` unless it was already done, then keep the
/// file beside itself as `<name>.imported`. A missing file imports nothing.
/// `now` places the raw window the imported history is compacted behind.
pub fn import_jsonl(store: &mut UsageStore, path: &Path, now: f64) -> Result<ImportReport, String> {
    let mut report = ImportReport::default();
    if store.imported()? {
        return Ok(report);
    }
    if !path.exists() {
        store.mark_imported("nothing", 0)?;
        return Ok(report);
    }
    let reader = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
    let mut lines = reader.lines().peekable();
    while lines.peek().is_some() {
        let tx = store.transaction()?;
        for raw in lines.by_ref().take(BATCH_LINES) {
            let raw = raw.map_err(|e| e.to_string())?;
            if raw.trim().is_empty() {
                continue;
            }
            report.lines += 1;
            let schema = serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|value| value.get("schemaVersion").and_then(|v| v.as_u64()));
            match schema {
                Some(version) if version > LINE_SCHEMA => {
                    report.withheld += 1;
                    continue;
                }
                Some(LINE_SCHEMA) => {}
                _ => {
                    report.skipped += 1;
                    continue;
                }
            }
            let Ok(line) = serde_json::from_str::<Line>(&raw) else {
                report.skipped += 1;
                continue;
            };
            debug_assert_eq!(line.schema_version, LINE_SCHEMA);
            UsageStore::seed_missing_in(&tx, &line.agent, &line.session_id, &base_before(&line))?;
            let usage = UsageReport {
                agent: line.agent.clone(),
                model: line.model.clone(),
                total_tokens: Some(line.observation.tokens.clone()),
                cost_usd: line.observation.cost_usd,
                reported_at: line.occurred_at,
                sequence: None,
            };
            let context = CaptureContext {
                workspace_id: line.workspace_id,
                workspace_name: line.workspace_name,
                workspace_cwd: line.workspace_cwd,
                pane_id: line.pane_id,
                pane_name: line.pane_name,
                session_id: line.session_id,
                origin: SessionOrigin::Fresh,
                worktree: line.worktree,
            };
            record_in(&tx, &usage, &context, line.captured_at, true)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    store.compact(now)?;
    let kept = PathBuf::from(format!("{}.imported", path.display()));
    std::fs::rename(path, &kept).map_err(|e| e.to_string())?;
    store.mark_imported(&kept.display().to_string(), report.withheld)?;
    report.kept_as = Some(kept);
    Ok(report)
}
