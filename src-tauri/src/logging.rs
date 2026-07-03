//! The app-wide log sink.
//!
//! Every `log::*!` call in the workspace — library crates included — lands
//! here via `tauri-plugin-log`. One file per run (`keepdeck-<pid>.log` under
//! `<keepdeck_home>/logs`), so concurrent instances (dev build + bundled app,
//! several windows) never race each other's rotation: a file has exactly one
//! writer for its lifetime.
//!
//! Rotation is two-level: the plugin caps a run's file size (`MAX_FILE_SIZE`,
//! older chunks are kept, not clobbered), and [`collect_garbage`] trims past
//! runs' files to a total budget at startup. A file that was written to
//! recently is never collected — it may belong to a live instance.
//!
//! Logging must never break the app: no target if the folder can't be
//! created, GC failures are ignored, and the panic hook delegates to the
//! default hook after recording.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use log::LevelFilter;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use crate::paths;

/// In-run cap per file; past it the plugin starts a new chunk (KeepAll).
const MAX_FILE_SIZE: u128 = 5 * 1024 * 1024;
/// Startup GC: total bytes kept across past runs' files.
const GC_BUDGET_BYTES: u64 = 20 * 1024 * 1024;
/// Startup GC: how many past files survive regardless of size.
const GC_BUDGET_FILES: usize = 10;
/// A file idle for less than this is never collected: with per-run names the
/// only recent writers are live instances.
const GC_MIN_IDLE: Duration = Duration::from_secs(24 * 60 * 60);

/// This run's log file name (sans the `.log` the plugin appends).
fn run_file_name() -> String {
    format!("keepdeck-{}", std::process::id())
}

/// The configured log plugin. Level: `KEEPDECK_LOG` env override, else Debug
/// in dev / Info in release. Dev builds also mirror to stdout and the webview
/// console; release writes only the file.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let mut targets = Vec::new();
    if let Some(dir) = paths::logs_dir() {
        // Pre-create so a failure downgrades to "no file log" instead of
        // failing plugin setup — logging never breaks the app.
        if fs::create_dir_all(&dir).is_ok() {
            targets.push(Target::new(TargetKind::Folder {
                path: dir,
                file_name: Some(run_file_name()),
            }));
        }
    }
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
        targets.push(Target::new(TargetKind::Webview));
    }
    tauri_plugin_log::Builder::new()
        .targets(targets)
        .level(level())
        .max_file_size(MAX_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepAll)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .build()
}

fn level() -> LevelFilter {
    let default = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    let Ok(wanted) = std::env::var("KEEPDECK_LOG") else {
        return default;
    };
    match wanted.trim().to_ascii_lowercase().as_str() {
        "off" => LevelFilter::Off,
        "error" => LevelFilter::Error,
        "warn" => LevelFilter::Warn,
        "info" => LevelFilter::Info,
        "debug" => LevelFilter::Debug,
        "trace" => LevelFilter::Trace,
        _ => default,
    }
}

/// Record panics in the log before the default hook takes over — a bundled
/// app's stderr goes nowhere, so this is often the only trace of a crash.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        default(info);
    }));
}

/// The session's first line: enough to place any later report (which build,
/// which process, which flavor).
pub fn banner() {
    log::info!(
        "KeepDeck {} pid={} ({}) on {}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        if cfg!(debug_assertions) { "dev" } else { "release" },
        std::env::consts::OS,
    );
}

/// A past run's log file, as seen by the GC planner.
struct LogFile {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

/// Trim past runs' files to the budget. Returns how many files were removed;
/// best-effort throughout. Runs before the plugin opens this run's file.
pub fn collect_garbage() -> usize {
    let Some(dir) = paths::logs_dir() else {
        return 0;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return 0;
    };
    let own = run_file_name();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("keepdeck-") || !name.contains(".log") || name.starts_with(&own) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        files.push(LogFile {
            path: entry.path(),
            size: meta.len(),
            modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        });
    }
    plan_gc(files, SystemTime::now())
        .iter()
        .filter(|path| fs::remove_file(path).is_ok())
        .count()
}

/// Pure GC decision: newest files survive until the count/byte budget runs
/// out; whatever is over budget is deleted only once idle past `GC_MIN_IDLE`.
/// A recent-but-over-budget file still occupies budget — it exists on disk.
fn plan_gc(mut files: Vec<LogFile>, now: SystemTime) -> Vec<PathBuf> {
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
    let mut kept_bytes = 0u64;
    let mut kept_files = 0usize;
    let mut doomed = Vec::new();
    for file in files {
        let over_budget =
            kept_files >= GC_BUDGET_FILES || kept_bytes.saturating_add(file.size) > GC_BUDGET_BYTES;
        let idle = now.duration_since(file.modified).unwrap_or_default();
        if over_budget && idle >= GC_MIN_IDLE {
            doomed.push(file.path);
        } else {
            kept_bytes = kept_bytes.saturating_add(file.size);
            kept_files += 1;
        }
    }
    doomed
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    fn file(name: &str, size: u64, modified: SystemTime) -> LogFile {
        LogFile {
            path: PathBuf::from(name),
            size,
            modified,
        }
    }

    fn now() -> SystemTime {
        // Fixed, deterministic "now" far from the epoch.
        SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000)
    }

    #[test]
    fn keeps_everything_within_budget() {
        let files = vec![
            file("a.log", 1024, now() - 2 * DAY),
            file("b.log", 1024, now() - 3 * DAY),
        ];
        assert!(plan_gc(files, now()).is_empty());
    }

    #[test]
    fn deletes_oldest_beyond_file_count() {
        let files: Vec<_> = (0..GC_BUDGET_FILES + 2)
            .map(|i| file(&format!("{i}.log"), 1, now() - 2 * DAY - i as u32 * DAY))
            .collect();
        let doomed = plan_gc(files, now());
        // The two oldest fall off the end.
        let last = GC_BUDGET_FILES + 1;
        let second_last = GC_BUDGET_FILES;
        assert_eq!(
            doomed,
            vec![
                PathBuf::from(format!("{second_last}.log")),
                PathBuf::from(format!("{last}.log")),
            ],
        );
    }

    #[test]
    fn deletes_oldest_beyond_byte_budget() {
        let big = GC_BUDGET_BYTES / 2 - 1024;
        let files = vec![
            file("new.log", big, now() - 2 * DAY),
            file("mid.log", big, now() - 3 * DAY),
            file("old.log", big, now() - 4 * DAY),
        ];
        // new + mid fit; old would overflow the byte budget.
        assert_eq!(plan_gc(files, now()), vec![PathBuf::from("old.log")]);
    }

    #[test]
    fn never_touches_recent_files_even_over_budget() {
        let huge = GC_BUDGET_BYTES + 1;
        let files = vec![
            file("live.log", huge, now() - Duration::from_secs(60)),
            file("old.log", huge, now() - 2 * DAY),
        ];
        // live.log is over budget but recent → spared; old.log goes.
        assert_eq!(plan_gc(files, now()), vec![PathBuf::from("old.log")]);
    }

    #[test]
    fn spared_recent_file_still_occupies_budget() {
        let half = GC_BUDGET_BYTES / 2 + 1;
        let files = vec![
            file("newest.log", half, now() - Duration::from_secs(60)),
            file("recent.log", half, now() - Duration::from_secs(120)),
            file("old.log", 1, now() - 2 * DAY),
        ];
        // The two recent files exhaust the byte budget between them, so the
        // old file is over budget even though it is tiny.
        assert_eq!(plan_gc(files, now()), vec![PathBuf::from("old.log")]);
    }

    #[test]
    fn empty_dir_plans_nothing() {
        assert!(plan_gc(Vec::new(), now()).is_empty());
    }
}
