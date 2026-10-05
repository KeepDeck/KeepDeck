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
pub fn files_of(path: &Path) -> [(PathBuf, &'static str); 3] {
    let with = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    [(path.to_path_buf(), ""), (with("-wal"), "-wal"), (with("-shm"), "-shm")]
}

/// Move a damaged database aside — never overwritten, never deleted: it is
/// the evidence, and what a manual `.recover` works from.
pub fn set_aside(path: &Path, now_ms: i64) -> Result<PathBuf> {
    let aside = path.with_file_name(format!("{DB_FILE}.damaged-{now_ms}"));
    for (from, suffix) in files_of(path) {
        if from.exists() {
            let mut to = aside.as_os_str().to_owned();
            to.push(suffix);
            std::fs::rename(&from, PathBuf::from(to))
                .map_err(|e| StoreError::Io { detail: format!("moving the damaged database aside: {e}") })?;
        }
    }
    Ok(aside)
}
