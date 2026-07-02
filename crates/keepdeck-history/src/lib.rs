//! `keepdeck-history` — read-only discovery over the on-disk session stores of
//! the supported agents ([F7]/[F8]; mechanics verified in RESUME_ANY_HISTORY.md).
//!
//! Discovery NEVER runs an agent CLI (several launch a TUI when invoked
//! carelessly) — it reads files and SQLite directly:
//!
//! - **claude** — `~/.claude/projects/<slug>/<uuid>.jsonl`, one folder per
//!   working directory (the slug), one file per session.
//! - **codex** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, global and
//!   date-partitioned; the first line (`session_meta`) records id + cwd.
//! - **opencode** — the `session` table of
//!   `~/.local/share/opencode/opencode.db` (SQLite), keyed by `directory`.
//!
//! Framework-free: store roots are injected (defaults via [`StoreRoots::from_home`])
//! so every provider is testable against fixtures.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A discovered agent session — the resume key plus its recency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRef {
    /// The agent's own session id (what its resume flag accepts).
    pub id: String,
    /// When the session's store entry was last written.
    pub modified: SystemTime,
}

/// Where the agents keep their stores. Injected so tests use fixtures.
#[derive(Debug, Clone)]
pub struct StoreRoots {
    /// `~/.claude/projects`
    pub claude_projects: PathBuf,
    /// `~/.codex/sessions`
    pub codex_sessions: PathBuf,
    /// `~/.local/share/opencode/opencode.db`
    pub opencode_db: PathBuf,
}

impl StoreRoots {
    /// The real stores under `home` (opencode uses the XDG data dir on macOS too).
    pub fn from_home(home: &Path) -> Self {
        Self {
            claude_projects: home.join(".claude/projects"),
            codex_sessions: home.join(".codex/sessions"),
            opencode_db: home.join(".local/share/opencode/opencode.db"),
        }
    }
}

/// The most recent session of `agent` recorded for working directory `dir`,
/// optionally only when written after `since` (the spawn-diff binding window).
/// Unknown agents and unreadable/missing stores yield `None`, never an error —
/// discovery is best-effort by design.
pub fn latest_session(
    roots: &StoreRoots,
    agent: &str,
    dir: &Path,
    since: Option<SystemTime>,
) -> Option<SessionRef> {
    match agent {
        "claude" => claude_latest(&roots.claude_projects, dir, since),
        "codex" => codex_latest(&roots.codex_sessions, dir, since),
        "opencode" => opencode_latest(&roots.opencode_db, dir, since),
        _ => None,
    }
}

// ---------------------------------------------------------------- claude ----

/// The directory-name slug Claude Code files a cwd's sessions under: every
/// `/`, `.` and `_` becomes `-` (verified empirically; see RESUME doc §2).
pub fn claude_slug(dir: &Path) -> String {
    dir.to_string_lossy()
        .chars()
        .map(|c| match c {
            '/' | '.' | '_' => '-',
            c => c,
        })
        .collect()
}

fn claude_latest(projects: &Path, dir: &Path, since: Option<SystemTime>) -> Option<SessionRef> {
    let slug_dir = projects.join(claude_slug(dir));
    let mut best: Option<SessionRef> = None;
    for entry in fs::read_dir(slug_dir).ok()? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(modified) = entry.metadata().ok().and_then(|m| m.modified().ok()) else {
            continue;
        };
        if !after(modified, since) {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if best.as_ref().map_or(true, |b| modified > b.modified) {
            best = Some(SessionRef {
                id: id.to_string(),
                modified,
            });
        }
    }
    best
}

// ----------------------------------------------------------------- codex ----

/// Runaway guard for the date-partitioned walk: only this many of the newest
/// day directories are examined. Sessions older than ~3 months aren't worth a
/// full-store scan on every restore.
const CODEX_DAY_DIRS_LIMIT: usize = 90;

fn codex_latest(sessions: &Path, dir: &Path, since: Option<SystemTime>) -> Option<SessionRef> {
    let wanted = dir.to_string_lossy();
    // Newest-first day walk: the first cwd match is the most recent session.
    for day in day_dirs_newest_first(sessions).into_iter().take(CODEX_DAY_DIRS_LIMIT) {
        let Ok(entries) = fs::read_dir(&day) else {
            continue; // one unreadable day must not abort the whole search
        };
        let mut files: Vec<(SystemTime, PathBuf)> = entries
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                let name = path.file_name()?.to_str()?;
                if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                    return None;
                }
                let modified = e.metadata().ok()?.modified().ok()?;
                after(modified, since).then_some((modified, path))
            })
            .collect();
        files.sort_by(|a, b| b.0.cmp(&a.0));
        for (modified, path) in files {
            if let Some(id) = codex_meta_id(&path, &wanted) {
                return Some(SessionRef { id, modified });
            }
        }
    }
    None
}

/// The session id from a rollout file's first line, when its recorded cwd
/// matches — `{"type":"session_meta","payload":{"id":…,"cwd":…}}`. Malformed
/// lines are skipped, not errors (the store is another program's private data).
fn codex_meta_id(path: &Path, wanted_cwd: &str) -> Option<String> {
    let content = read_first_line(path)?;
    let meta: serde_json::Value = serde_json::from_str(&content).ok()?;
    let payload = &meta["payload"];
    if payload["cwd"].as_str()? != wanted_cwd {
        return None;
    }
    Some(payload["id"].as_str()?.to_string())
}

fn read_first_line(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    Some(line)
}

/// `sessions/YYYY/MM/DD` leaf directories, newest date first. Non-numeric
/// entries are ignored; a lexicographic sort of zero-padded date parts IS the
/// chronological order.
fn day_dirs_newest_first(sessions: &Path) -> Vec<PathBuf> {
    fn sorted_desc(dir: &Path) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n.to_str().is_some_and(|s| s.chars().all(|c| c.is_ascii_digit()))))
            .collect();
        dirs.sort();
        dirs.reverse();
        dirs
    }
    let mut days = Vec::new();
    for year in sorted_desc(sessions) {
        for month in sorted_desc(&year) {
            days.extend(sorted_desc(&month));
        }
    }
    days
}

// -------------------------------------------------------------- opencode ----

fn opencode_latest(db: &Path, dir: &Path, since: Option<SystemTime>) -> Option<SessionRef> {
    if !db.exists() {
        return None;
    }
    // Read-only: the DB belongs to opencode (possibly running right now).
    let conn = rusqlite::Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    let dir = dir.to_string_lossy();
    let (id, time_updated): (String, i64) = conn
        .query_row(
            "SELECT id, time_updated FROM session WHERE directory = ?1 \
             ORDER BY time_updated DESC LIMIT 1",
            [dir.as_ref()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    let modified = epoch_time(time_updated)?;
    after(modified, since).then_some(SessionRef { id, modified })
}

/// `time_updated` as a `SystemTime`; the column holds epoch millis (Drizzle),
/// but plain seconds are tolerated in case the schema shifts.
fn epoch_time(value: i64) -> Option<SystemTime> {
    let value = u64::try_from(value).ok()?;
    let duration = if value > 100_000_000_000 {
        Duration::from_millis(value)
    } else {
        Duration::from_secs(value)
    };
    Some(UNIX_EPOCH + duration)
}

fn after(modified: SystemTime, since: Option<SystemTime>) -> bool {
    since.map_or(true, |s| modified > s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A unique fixture dir per CALL (std-only). The counter matters: tests
    /// run in parallel, and two sharing a tag-only dir race each other's setup.
    fn temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let base = std::env::temp_dir().join(format!(
            "kd-history-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn touch(path: &Path, content: &str, modified: SystemTime) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
    }

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn claude_slug_replaces_slash_dot_underscore() {
        assert_eq!(
            claude_slug(Path::new("/Users/me/my_app/v1.2")),
            "-Users-me-my-app-v1-2"
        );
    }

    #[test]
    fn claude_picks_the_newest_session_in_the_cwd_slug() {
        let projects = temp_dir("claude");
        let slug = projects.join(claude_slug(Path::new("/repo")));
        touch(&slug.join("old-uuid.jsonl"), "{}", at(1_000));
        touch(&slug.join("new-uuid.jsonl"), "{}", at(2_000));
        touch(&slug.join("notes.txt"), "x", at(3_000)); // ignored: not .jsonl

        let hit = claude_latest(&projects, Path::new("/repo"), None).unwrap();
        assert_eq!(hit.id, "new-uuid");
        assert_eq!(hit.modified, at(2_000));
    }

    #[test]
    fn claude_respects_the_since_window_and_missing_slug() {
        let projects = temp_dir("claude-since");
        let slug = projects.join(claude_slug(Path::new("/repo")));
        touch(&slug.join("uuid.jsonl"), "{}", at(1_000));

        assert!(claude_latest(&projects, Path::new("/repo"), Some(at(1_500))).is_none());
        assert!(claude_latest(&projects, Path::new("/elsewhere"), None).is_none());
    }

    fn codex_meta(id: &str, cwd: &str) -> String {
        format!(
            r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}"}}}}"#
        )
    }

    #[test]
    fn codex_matches_cwd_across_the_date_partition_newest_first() {
        let sessions = temp_dir("codex");
        touch(
            &sessions.join("2026/06/30/rollout-1-aaa.jsonl"),
            &codex_meta("aaa", "/repo"),
            at(1_000),
        );
        touch(
            &sessions.join("2026/07/02/rollout-2-bbb.jsonl"),
            &codex_meta("bbb", "/repo"),
            at(2_000),
        );
        touch(
            &sessions.join("2026/07/02/rollout-3-ccc.jsonl"),
            &codex_meta("ccc", "/other"),
            at(3_000),
        );

        let hit = codex_latest(&sessions, Path::new("/repo"), None).unwrap();
        assert_eq!(hit.id, "bbb"); // newest FOR THIS cwd, not newest overall
    }

    #[test]
    fn codex_skips_malformed_meta_lines_and_respects_since() {
        let sessions = temp_dir("codex-edge");
        touch(
            &sessions.join("2026/07/02/rollout-1-bad.jsonl"),
            "not json at all",
            at(2_000),
        );
        touch(
            &sessions.join("2026/07/01/rollout-2-ok.jsonl"),
            &codex_meta("ok", "/repo"),
            at(1_000),
        );

        let hit = codex_latest(&sessions, Path::new("/repo"), None).unwrap();
        assert_eq!(hit.id, "ok");
        assert!(codex_latest(&sessions, Path::new("/repo"), Some(at(1_500))).is_none());
    }

    fn opencode_fixture(rows: &[(&str, &str, i64)]) -> PathBuf {
        let db = temp_dir("opencode").join("opencode.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER)",
        )
        .unwrap();
        for (id, dir, updated) in rows {
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, ?3)",
                rusqlite::params![id, dir, updated],
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn opencode_queries_the_newest_session_for_the_directory() {
        let db = opencode_fixture(&[
            ("old", "/repo", 1_000_000_000_000),
            ("new", "/repo", 2_000_000_000_000),
            ("other", "/other", 3_000_000_000_000),
        ]);
        let hit = opencode_latest(&db, Path::new("/repo"), None).unwrap();
        assert_eq!(hit.id, "new");
        assert_eq!(hit.modified, UNIX_EPOCH + Duration::from_millis(2_000_000_000_000));
    }

    #[test]
    fn opencode_handles_missing_db_no_match_and_since() {
        assert!(opencode_latest(Path::new("/no/such.db"), Path::new("/x"), None).is_none());
        let db = opencode_fixture(&[("s", "/repo", 1_000_000_000_000)]);
        assert!(opencode_latest(&db, Path::new("/other"), None).is_none());
        assert!(opencode_latest(
            &db,
            Path::new("/repo"),
            Some(UNIX_EPOCH + Duration::from_millis(1_500_000_000_000)),
        )
        .is_none());
    }

    #[test]
    fn latest_session_dispatches_by_agent_and_rejects_unknown() {
        let home = temp_dir("dispatch");
        let roots = StoreRoots::from_home(&home);
        touch(
            &roots
                .claude_projects
                .join(claude_slug(Path::new("/repo")))
                .join("uuid-1.jsonl"),
            "{}",
            at(1_000),
        );

        assert_eq!(
            latest_session(&roots, "claude", Path::new("/repo"), None)
                .unwrap()
                .id,
            "uuid-1"
        );
        assert!(latest_session(&roots, "codex", Path::new("/repo"), None).is_none());
        assert!(latest_session(&roots, "unknown", Path::new("/repo"), None).is_none());
    }
}
