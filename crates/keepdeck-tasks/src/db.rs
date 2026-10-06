//! The database file: opening it so that what was answered "saved" is on
//! the disk, checking it before the first write, bringing its schema
//! forward, and what happens when it is found damaged.

use std::path::{Path, PathBuf};

use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_types::Text;
use diesel::migration::MigrationSource;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};

use crate::error::{Result, StoreError};

pub const DB_FILE: &str = "tasks.db";

/// The schema's steps, compiled into the binary.
pub const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

/// How long a write waits for another opener (a DB browser, a backup tool)
/// to let go before answering `Busy`.
const BUSY_TIMEOUT_MS: u32 = 5_000;

/// The size the write-ahead log is cut back to after a checkpoint.
const JOURNAL_SIZE_LIMIT: u64 = 16 * 1024 * 1024;

/// Open the database for reading and writing, check it, and bring its
/// schema forward. Every write is durable when its transaction returns:
/// the UI and the agents are told "saved" (`synchronous = FULL`; a board
/// is written by people and agents, not in bulk, so it costs a few ms).
pub fn open(path: &Path) -> Result<SqliteConnection> {
    let mut conn = SqliteConnection::establish(&path.to_string_lossy())?;
    conn.batch_execute(&format!("PRAGMA busy_timeout = {BUSY_TIMEOUT_MS};"))?;
    // The check comes before any write, the schema's included.
    quick_check(&mut conn)?;
    conn.batch_execute(&format!(
        // WAL: readers (a backup being taken) never wait for the writer.
        // FULL: a committed change is on the disk before "saved" is said.
        // journal_size_limit: the log shrinks back after each checkpoint.
        // secure_delete: a deleted board leaves nothing in free pages.
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA journal_size_limit = {JOURNAL_SIZE_LIMIT};
         PRAGMA foreign_keys = ON;
         PRAGMA trusted_schema = OFF;
         PRAGMA secure_delete = ON;
         PRAGMA temp_store = MEMORY;"
    ))?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// Bring the schema to this build's migrations — or refuse a database a
/// newer build migrated further, before writing a byte.
fn migrate(conn: &mut SqliteConnection) -> Result<()> {
    let known: Vec<String> =
        MigrationSource::<diesel::sqlite::Sqlite>::migrations(&MIGRATIONS)
            .map_err(io)?
            .iter()
            .map(|m| m.name().version().to_string())
            .collect();
    let applied = conn.applied_migrations().map_err(io)?;
    if let Some(unknown) = applied.iter().map(|v| v.to_string()).find(|v| !known.contains(v)) {
        return Err(StoreError::SchemaTooNew { migration: unknown });
    }
    conn.run_pending_migrations(MIGRATIONS).map_err(io)?;
    Ok(())
}

fn io(error: Box<dyn std::error::Error + Send + Sync>) -> StoreError {
    StoreError::Io { detail: error.to_string() }
}

#[derive(QueryableByName)]
struct Verdict {
    #[diesel(sql_type = Text)]
    quick_check: String,
}

/// SQLite's own bounded check (milliseconds at a board's size): anything
/// but "ok" is damage.
pub fn quick_check(conn: &mut SqliteConnection) -> Result<()> {
    let verdicts: Vec<Verdict> = diesel::sql_query("PRAGMA quick_check").load(conn)?;
    match verdicts.first() {
        Some(v) if v.quick_check == "ok" => Ok(()),
        Some(v) => Err(StoreError::Corrupt { detail: v.quick_check.clone() }),
        None => Err(StoreError::Corrupt { detail: "quick_check said nothing".into() }),
    }
}

/// Open a database only to read it — a backup being checked.
pub fn open_read_only(path: &Path) -> Result<SqliteConnection> {
    if !path.exists() {
        return Err(StoreError::Io { detail: format!("{} does not exist", path.display()) });
    }
    let mut conn = SqliteConnection::establish(&format!("file:{}?mode=ro", path.to_string_lossy()))?;
    conn.batch_execute(&format!("PRAGMA busy_timeout = {BUSY_TIMEOUT_MS};"))?;
    Ok(conn)
}

/// Fold the write-ahead log into the database file, so a copy of
/// `tasks.db` alone holds the latest boards — at disable and exit.
pub fn checkpoint(conn: &mut SqliteConnection) -> Result<()> {
    // `optimize` keeps the query planner's statistics current as boards grow.
    conn.batch_execute("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

/// The files of a database: the main file and its WAL companions.
fn files_of(path: &Path) -> [PathBuf; 3] {
    let with = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    [path.to_path_buf(), with("-wal"), with("-shm")]
}

/// Move a database aside — never overwritten, never deleted: it is the
/// evidence, and what a manual `.recover` works from. Nothing there,
/// nothing moved.
pub fn set_aside(path: &Path, now_ms: i64) -> Result<PathBuf> {
    let aside = path.with_file_name(format!("{DB_FILE}.damaged-{now_ms}"));
    move_files(path, &aside).map_err(|e| StoreError::Io { detail: format!("moving the database aside: {e}") })?;
    Ok(aside)
}

/// Where a restore builds its candidate, beside the database.
pub fn staged_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{DB_FILE}.restoring"))
}

/// Build a restore's candidate at `staged` and check it there: what takes
/// the database's place has passed the check BEFORE anything is moved. A
/// candidate that fails is removed.
pub fn stage(staged: &Path, build: impl FnOnce(&Path) -> Result<()>) -> Result<()> {
    remove_files(staged);
    let built = build(staged).and_then(|()| quick_check(&mut open_read_only(staged)?));
    if built.is_err() {
        remove_files(staged);
    }
    built
}

/// A copy of `from` at `to` that is on the disk when this returns.
pub fn copy_durably(from: &Path, to: &Path) -> Result<()> {
    let copied = std::fs::copy(from, to).and_then(|_| std::fs::File::open(to)?.sync_all());
    copied.map_err(|e| StoreError::Io { detail: format!("copying {}: {e}", from.display()) })
}

/// Put a checked candidate in the database's place: what is there goes
/// aside first, then the candidate moves in. Either both happen or the
/// files are as they were.
pub fn replace(path: &Path, staged: &Path, now_ms: i64) -> Result<()> {
    let aside = set_aside(path, now_ms)?;
    if let Err(e) = move_files(staged, path) {
        if let Err(back) = move_files(&aside, path) {
            log::error!("tasks: the database stays at {} — moving it back failed: {back}", aside.display());
        }
        remove_files(staged);
        return Err(StoreError::Io { detail: format!("placing the restored database: {e}") });
    }
    if let Some(dir) = path.parent() {
        // The renames themselves are on the disk, not only the files.
        let _ = std::fs::File::open(dir).and_then(|d| d.sync_all());
    }
    Ok(())
}

/// Move a database's files (main file, WAL companions) from one name to
/// another; a failure halfway moves back what had moved.
fn move_files(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (source, target) in files_of(from).into_iter().zip(files_of(to)) {
        if !source.exists() {
            continue;
        }
        if let Err(e) = std::fs::rename(&source, &target) {
            for (source, target) in moved.iter().rev() {
                let _ = std::fs::rename(target, source);
            }
            return Err(e);
        }
        moved.push((source, target));
    }
    Ok(())
}

fn remove_files(path: &Path) {
    for file in files_of(path) {
        let _ = std::fs::remove_file(file);
    }
}
