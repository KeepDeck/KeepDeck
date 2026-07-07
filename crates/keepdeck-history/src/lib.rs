//! `keepdeck-history` — read-only discovery over the on-disk session stores of
//! the supported agents ([F7]/[F8]).
//!
//! Everything agent-specific lives behind [`SessionProvider`] — one
//! implementation per agent, registered in [`SessionProviders`]. The registry
//! is pure orchestration: supporting a new agent means implementing the trait,
//! nothing else changes (the architecture agreed for session identity v2).
//!
//! Discovery NEVER runs an agent CLI (several launch a TUI when invoked
//! carelessly) — it reads files and SQLite directly:
//!
//! - **claude** — `~/.claude/projects/<slug>/<uuid>.jsonl`, one folder per
//!   working directory (the slug), one file per session.
//! - **codex** — `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`,
//!   global and date-partitioned; the filename uuid IS the session id.
//! - **opencode** — the `session` table of
//!   `~/.local/share/opencode/opencode.db` (SQLite), keyed by `directory`.

pub mod codex_hook;

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

/// Pre-resume validation outcome: only a *definitive* absence may drop a
/// session binding — a store that can't answer (locked SQLite, IO error)
/// must keep it, or a still-resumable conversation is lost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    /// The session is in the store — resume will find it.
    Present,
    /// The store answered, and the session is not there.
    Absent,
    /// The store couldn't answer — absence is unproven.
    Unknown,
}

/// One agent's session mechanics, behind one interface. Implementations are
/// read-only over the agent's own store and best-effort by design — an
/// unreadable store yields `None`/[`Presence::Unknown`], never an error.
pub trait SessionProvider: Send + Sync {
    /// The catalog agent id this provider serves (`"claude"`).
    fn agent_id(&self) -> &'static str;
    /// The most recent session recorded for working directory `dir`,
    /// optionally only when written after `since`.
    fn latest(&self, dir: &Path, since: Option<SystemTime>) -> Option<SessionRef>;
    /// Whether session `id` is still in the store for `dir` — pre-resume
    /// validation (agents GC/rotate their stores; a stale id must degrade,
    /// not crash).
    fn exists(&self, id: &str, dir: &Path) -> Presence;
}

/// The provider registry — the pure "session manager" core. Knows nothing
/// about any concrete agent.
pub struct SessionProviders {
    providers: Vec<Box<dyn SessionProvider>>,
}

impl SessionProviders {
    /// The real stores under `home` (opencode uses the XDG data dir on macOS too).
    pub fn from_home(home: &Path) -> Self {
        Self::with(vec![
            Box::new(ClaudeProvider {
                projects: home.join(".claude/projects"),
            }),
            Box::new(CodexProvider {
                sessions: home.join(".codex/sessions"),
            }),
            Box::new(OpencodeProvider {
                db: home.join(".local/share/opencode/opencode.db"),
            }),
        ])
    }

    /// Custom provider set — dependency injection for tests and future agents.
    pub fn with(providers: Vec<Box<dyn SessionProvider>>) -> Self {
        Self { providers }
    }

    /// The provider serving `agent`, if the catalog knows it.
    pub fn get(&self, agent: &str) -> Option<&dyn SessionProvider> {
        self.providers
            .iter()
            .find(|p| p.agent_id() == agent)
            .map(|p| p.as_ref())
    }

    /// [`SessionProvider::latest`] dispatched by agent id.
    pub fn latest_session(
        &self,
        agent: &str,
        dir: &Path,
        since: Option<SystemTime>,
    ) -> Option<SessionRef> {
        self.get(agent)?.latest(dir, since)
    }

    /// [`SessionProvider::exists`] dispatched by agent id. An agent the
    /// catalog doesn't know can't be resumed at all — that is an
    /// [`Presence::Absent`], not an [`Presence::Unknown`].
    pub fn session_presence(&self, agent: &str, id: &str, dir: &Path) -> Presence {
        self.get(agent)
            .map_or(Presence::Absent, |p| p.exists(id, dir))
    }
}

// ---------------------------------------------------------------- claude ----

/// Claude Code: one folder per working directory under `projects`, one
/// `<uuid>.jsonl` per session.
pub struct ClaudeProvider {
    /// `~/.claude/projects`
    pub projects: PathBuf,
}

/// The directory-name slug Claude Code files a cwd's sessions under: every
/// `/`, `.` and `_` becomes `-` (verified empirically). Claude slugs the
/// RESOLVED path, so callers canonicalize first (see [`canonical`]).
pub fn claude_slug(dir: &Path) -> String {
    dir.to_string_lossy()
        .chars()
        .map(|c| match c {
            '/' | '.' | '_' => '-',
            c => c,
        })
        .collect()
}

impl ClaudeProvider {
    fn slug_dir(&self, dir: &Path) -> PathBuf {
        self.projects.join(claude_slug(&canonical(dir)))
    }
}

impl SessionProvider for ClaudeProvider {
    fn agent_id(&self) -> &'static str {
        "claude"
    }

    fn latest(&self, dir: &Path, since: Option<SystemTime>) -> Option<SessionRef> {
        let mut best: Option<SessionRef> = None;
        for entry in fs::read_dir(self.slug_dir(dir)).ok()? {
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

    fn exists(&self, id: &str, dir: &Path) -> Presence {
        if id.is_empty() || id.contains('/') {
            return Presence::Absent;
        }
        match fs::metadata(self.slug_dir(dir).join(format!("{id}.jsonl"))) {
            Ok(meta) if meta.is_file() => Presence::Present,
            Ok(_) => Presence::Absent,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Presence::Absent,
            Err(_) => Presence::Unknown,
        }
    }
}

// ----------------------------------------------------------------- codex ----

/// Codex: a global, date-partitioned store; the rollout FILENAME embeds the
/// session id (`rollout-<local-ts>-<uuid>.jsonl`, later maybe `.jsonl.zst`).
pub struct CodexProvider {
    /// `~/.codex/sessions`
    pub sessions: PathBuf,
}

/// Runaway guard for the date-partitioned DISCOVERY walk (`latest`): only
/// this many of the newest day directories are examined — sessions older
/// than ~3 months aren't worth a full-store scan. `exists` deliberately does
/// NOT apply it: it validates a KNOWN id, and a capped miss would report a
/// still-resumable session as gone and wipe its binding.
const CODEX_DAY_DIRS_LIMIT: usize = 90;

impl SessionProvider for CodexProvider {
    fn agent_id(&self) -> &'static str {
        "codex"
    }

    fn latest(&self, dir: &Path, since: Option<SystemTime>) -> Option<SessionRef> {
        let wanted = cwd_candidates(dir);
        // Track the highest-mtime cwd match across day dirs rather than returning
        // on the first — a rollout's mtime can spill past midnight into a day
        // AFTER the date dir it's filed under, so the most recent session isn't
        // always in the newest day dir. The mtime break below keeps the extra
        // day dirs cheap: once a match is found, an older day dir only pays for
        // the files whose mtime still beats it (a straggler or two).
        let mut best: Option<SessionRef> = None;
        for day in day_dirs_newest_first(&self.sessions)
            .into_iter()
            .take(CODEX_DAY_DIRS_LIMIT)
        {
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
                // Files are newest-first; once they drop to/below the best match
                // found so far, neither this day nor an older one can improve it.
                if best.as_ref().map_or(false, |b| modified <= b.modified) {
                    break;
                }
                if let Some(id) = codex_meta_id(&path, &wanted) {
                    best = Some(SessionRef { id, modified });
                    break; // the newest match in this day dir
                }
            }
        }
        best
    }

    /// The id is embedded in the filename, so existence = "any rollout file
    /// ending in `<id>.jsonl` (or its compressed form)". `dir` is irrelevant —
    /// codex resolves ids globally. Uncapped (see [`CODEX_DAY_DIRS_LIMIT`]),
    /// and absence holds only when every day dir was actually scanned.
    fn exists(&self, id: &str, _dir: &Path) -> Presence {
        if id.is_empty() || id.contains('/') {
            return Presence::Absent;
        }
        let plain = format!("{id}.jsonl");
        let zst = format!("{id}.jsonl.zst");
        let (days, mut complete) = day_dirs_checked(&self.sessions);
        for day in days {
            let Ok(entries) = fs::read_dir(&day) else {
                complete = false; // an unreadable day leaves absence unproven
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if name.starts_with("rollout-")
                    && (name.ends_with(&plain) || name.ends_with(&zst))
                {
                    return Presence::Present;
                }
            }
        }
        if complete {
            Presence::Absent
        } else {
            Presence::Unknown
        }
    }
}

/// The session id from a rollout file's first line, when its recorded cwd
/// matches one of the wanted spellings —
/// `{"type":"session_meta","payload":{"id":…,"cwd":…}}`. Malformed lines are
/// skipped, not errors (the store is another program's private data).
fn codex_meta_id(path: &Path, wanted_cwds: &[String]) -> Option<String> {
    let content = read_first_line(path)?;
    let meta: serde_json::Value = serde_json::from_str(&content).ok()?;
    let payload = &meta["payload"];
    let cwd = payload["cwd"].as_str()?;
    if !wanted_cwds.iter().any(|wanted| wanted == cwd) {
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
    day_dirs_checked(sessions).0
}

/// [`day_dirs_newest_first`] plus a completeness flag: `true` when every
/// level was actually listed. A MISSING store root is complete (nothing was
/// ever recorded — a definitive answer); any other listing failure means the
/// walk may have skipped sessions.
fn day_dirs_checked(sessions: &Path) -> (Vec<PathBuf>, bool) {
    fn sorted_desc(dir: &Path) -> (Vec<PathBuf>, bool) {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) => return (Vec::new(), e.kind() == std::io::ErrorKind::NotFound),
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && p.file_name()
                        .is_some_and(|n| n.to_str().is_some_and(|s| s.chars().all(|c| c.is_ascii_digit())))
            })
            .collect();
        dirs.sort();
        dirs.reverse();
        (dirs, true)
    }
    let mut days = Vec::new();
    let (years, mut complete) = sorted_desc(sessions);
    for year in years {
        let (months, ok) = sorted_desc(&year);
        complete &= ok;
        for month in months {
            let (day_dirs, ok) = sorted_desc(&month);
            complete &= ok;
            days.extend(day_dirs);
        }
    }
    (days, complete)
}

// -------------------------------------------------------------- opencode ----

/// OpenCode: a single SQLite store, `session` table keyed by `directory`.
/// Read-only always — the DB belongs to opencode (possibly running right now).
pub struct OpencodeProvider {
    /// `~/.local/share/opencode/opencode.db`
    pub db: PathBuf,
}

/// How long a query waits out another process's write lock before failing —
/// the DB belongs to a possibly-running opencode, so brief locks are normal.
const OPENCODE_BUSY_TIMEOUT: Duration = Duration::from_millis(500);

impl OpencodeProvider {
    /// Read-only connection with the busy timeout applied.
    fn connect(&self) -> rusqlite::Result<rusqlite::Connection> {
        let conn = rusqlite::Connection::open_with_flags(
            &self.db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        conn.busy_timeout(OPENCODE_BUSY_TIMEOUT)?;
        Ok(conn)
    }

    /// Best-effort connection for discovery (`latest`).
    fn open(&self) -> Option<rusqlite::Connection> {
        if !self.db.exists() {
            return None;
        }
        self.connect().ok()
    }
}

impl SessionProvider for OpencodeProvider {
    fn agent_id(&self) -> &'static str {
        "opencode"
    }

    fn latest(&self, dir: &Path, since: Option<SystemTime>) -> Option<SessionRef> {
        let conn = self.open()?;
        let dirs = cwd_candidates(dir);
        if dirs.is_empty() {
            return None;
        }
        // One placeholder per cwd spelling, bound from the whole list — a fixed
        // two (`dirs[0]`, `dirs[last]`) would silently drop a third candidate
        // should cwd_candidates ever return more than two.
        let placeholders = (1..=dirs.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id, time_updated FROM session WHERE directory IN ({placeholders}) \
             ORDER BY time_updated DESC LIMIT 1"
        );
        let (id, time_updated): (String, i64) = conn
            .query_row(&sql, rusqlite::params_from_iter(dirs.iter()), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .ok()?;
        let modified = epoch_time(time_updated)?;
        after(modified, since).then_some(SessionRef { id, modified })
    }

    fn exists(&self, id: &str, _dir: &Path) -> Presence {
        match self.db.try_exists() {
            Ok(false) => return Presence::Absent, // store never created
            Ok(true) => {}
            Err(_) => return Presence::Unknown,
        }
        let Ok(conn) = self.connect() else {
            return Presence::Unknown;
        };
        match conn.query_row(
            "SELECT 1 FROM session WHERE id = ?1 LIMIT 1",
            [id],
            |_| Ok(()),
        ) {
            Ok(()) => Presence::Present,
            Err(rusqlite::Error::QueryReturnedNoRows) => Presence::Absent,
            // Locked / corrupt / IO — the store didn't answer; absence is
            // unproven and the binding must survive.
            Err(_) => Presence::Unknown,
        }
    }
}

// ---------------------------------------------------------------- shared ----

/// The resolved (symlink-free) form of `dir` — Claude Code slugs the REAL
/// path (`/var` → `/private/var` on macOS), so discovery must too. Falls back
/// to the path as given when it no longer resolves.
fn canonical(dir: &Path) -> PathBuf {
    dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf())
}

/// The cwd spellings an agent may have recorded for `dir`: as given, plus the
/// resolved form when it differs. Agents typically record their own
/// (symlink-free) getcwd while the deck stores the logical pane path — under
/// a symlinked root (macOS `/tmp`, `/var`) the two never literally match.
/// Offering BOTH keeps the literal case working exactly as before.
fn cwd_candidates(dir: &Path) -> Vec<String> {
    let raw = dir.to_string_lossy().into_owned();
    let resolved = canonical(dir).to_string_lossy().into_owned();
    if resolved == raw {
        vec![raw]
    } else {
        vec![raw, resolved]
    }
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

    /// The slug of `dir` as the provider computes it (canonicalized).
    fn slug_of(dir: &Path) -> String {
        claude_slug(&dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf()))
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
        let base = temp_dir("claude");
        let cwd = base.join("repo");
        fs::create_dir_all(&cwd).unwrap();
        let provider = ClaudeProvider {
            projects: base.join("projects"),
        };
        let slug = provider.projects.join(slug_of(&cwd));
        touch(&slug.join("old-uuid.jsonl"), "{}", at(1_000));
        touch(&slug.join("new-uuid.jsonl"), "{}", at(2_000));
        touch(&slug.join("notes.txt"), "x", at(3_000)); // ignored: not .jsonl

        let hit = provider.latest(&cwd, None).unwrap();
        assert_eq!(hit.id, "new-uuid");
        assert_eq!(hit.modified, at(2_000));
    }

    #[test]
    fn claude_respects_the_since_window_missing_slug_and_exists() {
        let base = temp_dir("claude-since");
        let cwd = base.join("repo");
        fs::create_dir_all(&cwd).unwrap();
        let provider = ClaudeProvider {
            projects: base.join("projects"),
        };
        let slug = provider.projects.join(slug_of(&cwd));
        touch(&slug.join("uuid.jsonl"), "{}", at(1_000));

        assert!(provider.latest(&cwd, Some(at(1_500))).is_none());
        assert!(provider.latest(Path::new("/elsewhere"), None).is_none());

        assert_eq!(provider.exists("uuid", &cwd), Presence::Present);
        assert_eq!(provider.exists("gone", &cwd), Presence::Absent);
        assert_eq!(provider.exists("../uuid", &cwd), Presence::Absent); // no path tricks
    }

    fn codex_meta(id: &str, cwd: &str) -> String {
        format!(r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}"}}}}"#)
    }

    #[test]
    fn codex_matches_cwd_across_the_date_partition_newest_first() {
        let sessions = temp_dir("codex");
        let provider = CodexProvider {
            sessions: sessions.clone(),
        };
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

        let hit = provider.latest(Path::new("/repo"), None).unwrap();
        assert_eq!(hit.id, "bbb"); // newest FOR THIS cwd, not newest overall
    }

    #[test]
    fn codex_skips_malformed_meta_respects_since_and_finds_by_id() {
        let sessions = temp_dir("codex-edge");
        let provider = CodexProvider {
            sessions: sessions.clone(),
        };
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
        touch(
            &sessions.join("2026/06/01/rollout-3-zzz.jsonl.zst"),
            "compressed",
            at(500),
        );

        assert_eq!(provider.latest(Path::new("/repo"), None).unwrap().id, "ok");
        assert!(provider.latest(Path::new("/repo"), Some(at(1_500))).is_none());

        // exists() is filename-based and dir-independent; .zst counts too.
        assert_eq!(provider.exists("ok", Path::new("/anywhere")), Presence::Present);
        assert_eq!(provider.exists("zzz", Path::new("/anywhere")), Presence::Present);
        assert_eq!(provider.exists("nope", Path::new("/anywhere")), Presence::Absent);
        assert_eq!(provider.exists("", Path::new("/anywhere")), Presence::Absent);
    }

    #[test]
    fn codex_latest_prefers_higher_mtime_across_a_midnight_boundary() {
        // A session filed under an OLDER date dir but still active past midnight
        // carries a LATER mtime than a fresh session in the NEWER date dir. The
        // newest by mtime must win, not the one in the newest day dir.
        let sessions = temp_dir("codex-midnight");
        let provider = CodexProvider {
            sessions: sessions.clone(),
        };
        // Newer date dir, earlier mtime.
        touch(
            &sessions.join("2026/07/06/rollout-1-newday.jsonl"),
            &codex_meta("newday", "/repo"),
            at(1_000),
        );
        // Older date dir, LATER mtime — spilled past midnight.
        touch(
            &sessions.join("2026/07/05/rollout-2-straggler.jsonl"),
            &codex_meta("straggler", "/repo"),
            at(2_000),
        );
        assert_eq!(
            provider.latest(Path::new("/repo"), None).unwrap().id,
            "straggler",
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_matches_a_symlinked_cwd_in_both_spellings() {
        // Agents record their own (resolved) getcwd; the deck stores the
        // logical pane path. Under a symlinked root (macOS /tmp, /var) the
        // raw spelling alone never matches — both must.
        let base = temp_dir("codex-link");
        let real = base.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let resolved = link.canonicalize().unwrap();

        let sessions = base.join("sessions");
        let provider = CodexProvider {
            sessions: sessions.clone(),
        };
        touch(
            &sessions.join("2026/07/03/rollout-1-aaa.jsonl"),
            &codex_meta("aaa", &resolved.to_string_lossy()),
            at(1_000),
        );
        // Queried by the SYMLINK, recorded resolved — the canonical candidate.
        assert_eq!(provider.latest(&link, None).unwrap().id, "aaa");

        touch(
            &sessions.join("2026/07/03/rollout-2-bbb.jsonl"),
            &codex_meta("bbb", &link.to_string_lossy()),
            at(2_000),
        );
        // A raw-path recording still matches too; the newest wins.
        assert_eq!(provider.latest(&link, None).unwrap().id, "bbb");
    }

    #[test]
    fn codex_exists_finds_a_session_beyond_the_discovery_cap() {
        // `latest` caps its walk at CODEX_DAY_DIRS_LIMIT day dirs; `exists`
        // must NOT — a capped miss would wipe a still-resumable binding.
        let sessions = temp_dir("codex-old");
        let provider = CodexProvider {
            sessions: sessions.clone(),
        };
        // The wanted session sits in the OLDEST of limit+5 populated days.
        let days = CODEX_DAY_DIRS_LIMIT + 5;
        for n in 0..days {
            touch(
                &sessions.join(format!("2026/01/{:03}/rollout-1-day{n}.jsonl", days - n)),
                "{}",
                at(1_000 + n as u64),
            );
        }
        touch(
            &sessions.join("2026/01/000/rollout-0-ancient.jsonl"),
            "{}",
            at(1),
        );

        assert_eq!(
            provider.exists("ancient", Path::new("/anywhere")),
            Presence::Present
        );
        assert_eq!(
            provider.exists("never-was", Path::new("/anywhere")),
            Presence::Absent
        );
    }

    fn opencode_fixture(rows: &[(&str, &str, i64)]) -> OpencodeProvider {
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
        OpencodeProvider { db }
    }

    #[test]
    fn opencode_queries_the_newest_session_for_the_directory() {
        let provider = opencode_fixture(&[
            ("old", "/repo", 1_000_000_000_000),
            ("new", "/repo", 2_000_000_000_000),
            ("other", "/other", 3_000_000_000_000),
        ]);
        let hit = provider.latest(Path::new("/repo"), None).unwrap();
        assert_eq!(hit.id, "new");
        assert_eq!(
            hit.modified,
            UNIX_EPOCH + Duration::from_millis(2_000_000_000_000)
        );
    }

    #[test]
    fn opencode_handles_missing_db_no_match_since_and_exists() {
        let missing = OpencodeProvider {
            db: PathBuf::from("/no/such.db"),
        };
        assert!(missing.latest(Path::new("/x"), None).is_none());
        // A store that was never created is a DEFINITIVE absence.
        assert_eq!(missing.exists("s", Path::new("/x")), Presence::Absent);

        let provider = opencode_fixture(&[("s", "/repo", 1_000_000_000_000)]);
        assert!(provider.latest(Path::new("/other"), None).is_none());
        assert!(provider
            .latest(
                Path::new("/repo"),
                Some(UNIX_EPOCH + Duration::from_millis(1_500_000_000_000)),
            )
            .is_none());
        assert_eq!(provider.exists("s", Path::new("/anywhere")), Presence::Present);
        assert_eq!(provider.exists("nope", Path::new("/anywhere")), Presence::Absent);
    }

    #[cfg(unix)]
    #[test]
    fn opencode_matches_a_symlinked_cwd_in_both_spellings() {
        let base = temp_dir("opencode-link");
        let real = base.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let resolved = link.canonicalize().unwrap();
        let resolved = resolved.to_string_lossy();

        let provider = opencode_fixture(&[("linked", resolved.as_ref(), 1_000_000_000_000)]);
        // Queried by the SYMLINK, recorded resolved — must still be found.
        assert_eq!(provider.latest(&link, None).unwrap().id, "linked");
    }

    #[test]
    fn opencode_reports_unknown_when_the_store_cannot_answer() {
        // A present-but-unreadable DB (here: not SQLite at all — stands in
        // for locked/corrupt) must NOT report absence: that wipes a binding
        // `opencode -s` would still accept.
        let db = temp_dir("opencode-bad").join("opencode.db");
        fs::write(&db, "not a sqlite database").unwrap();
        let provider = OpencodeProvider { db };

        assert_eq!(
            provider.exists("s", Path::new("/anywhere")),
            Presence::Unknown
        );
        assert!(provider.latest(Path::new("/repo"), None).is_none()); // still best-effort
    }

    #[test]
    fn registry_dispatches_by_agent_and_rejects_unknown() {
        let base = temp_dir("registry");
        let cwd = base.join("repo");
        fs::create_dir_all(&cwd).unwrap();
        let claude = ClaudeProvider {
            projects: base.join("projects"),
        };
        touch(
            &claude.projects.join(slug_of(&cwd)).join("uuid-1.jsonl"),
            "{}",
            at(1_000),
        );
        let providers = SessionProviders::with(vec![Box::new(claude)]);

        assert_eq!(
            providers.latest_session("claude", &cwd, None).unwrap().id,
            "uuid-1"
        );
        assert_eq!(
            providers.session_presence("claude", "uuid-1", &cwd),
            Presence::Present
        );
        assert!(providers.latest_session("unknown", &cwd, None).is_none());
        // An agent outside the catalog can't be resumed — definitive absence.
        assert_eq!(
            providers.session_presence("unknown", "x", &cwd),
            Presence::Absent
        );
    }
}
