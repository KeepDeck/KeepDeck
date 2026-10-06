//! The task board's store: ONE SQLite database holding every board — the
//! sole truth of the tracker (board-db-design, task-221).
//!
//! Who owns what: the TS domain owns every rule about what a task is and
//! what a change means; this crate owns the disk — the schema and its
//! migrations, every line of SQL, and the guarantees only the disk can
//! give: a change lands whole or not at all, is never applied twice, never
//! takes a number back, never deletes history, and what was answered
//! "saved" is on the disk. Nothing here knows what a status means.
//!
//! A damaged database (or one a newer build wrote) puts the store in a
//! state that writes nothing and takes no backups; the way out is a
//! restore the person confirms.

pub mod backup;
pub mod board;
pub mod db;
pub mod error;
pub mod import;
mod meta;
pub mod model;
mod rows;
mod schema;
pub mod search;

use std::path::{Path, PathBuf};

use diesel::SqliteConnection;

pub use error::{Result, StoreError};
pub use import::{LegacyBoard, MigrationSource, MigrationState};
pub use model::*;

/// Where the store stands, for the UI and the agents' refusals.
#[derive(Debug, Clone, PartialEq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export, export_to = "tasks/")]
pub enum StoreStatus {
    Ready { migration: MigrationState },
    /// Damaged: nothing is written. The backups that pass the check now,
    /// newest first, ms since the epoch.
    Damaged {
        detail: String,
        #[ts(type = "number[]")]
        backups: Vec<i64>,
    },
    /// The database is gone though earlier data is beside it: nothing is
    /// created until the person restores a backup or starts empty.
    Missing {
        detail: String,
        #[ts(type = "number[]")]
        backups: Vec<i64>,
    },
    /// Written by a newer KeepDeck: nothing is written.
    TooNew { migration: String },
}

enum State {
    /// `writes` counts the writes that landed; `backed_up` is the count the
    /// newest backup was decided at — they differ while the boards changed
    /// since.
    Open { conn: SqliteConnection, writes: u64, backed_up: u64 },
    Unusable(StoreError),
}

/// A backup the store decided is due, taken on a connection of its own.
pub struct BackupJob {
    db_path: PathBuf,
    dir: PathBuf,
    at: i64,
    /// The store's write count when it was decided.
    writes: u64,
}

impl BackupJob {
    pub fn take(&self) -> Result<backup::Backup> {
        backup::take(&self.db_path, &self.dir, self.at)
    }
}

/// The database of `<root>/tasks.db`, with its backups in `<root>/backups`.
pub struct Store {
    root: PathBuf,
    state: State,
}

impl Store {
    /// Open the store under `root`. A damaged, missing or too-new database
    /// is no failure to open: the store opens in the state that says so.
    pub fn open(root: &Path) -> Result<Store> {
        std::fs::create_dir_all(root)
            .map_err(|e| StoreError::Io { detail: format!("creating {}: {e}", root.display()) })?;
        let path = root.join(db::DB_FILE);
        if !path.exists() {
            if let Some(detail) = earlier_data(root)? {
                let error = StoreError::Missing { detail };
                log_unusable(&error);
                return Ok(Store { root: root.to_path_buf(), state: State::Unusable(error) });
            }
        }
        let state = match db::open(&path) {
            // Changed since the newest backup in an earlier session — the
            // data a crash before the next hourly copy would lose.
            Ok(conn) => State::Open { conn, writes: u64::from(newer_than_backups(&path, root)), backed_up: 0 },
            Err(error @ (StoreError::Corrupt { .. } | StoreError::SchemaTooNew { .. })) => {
                log_unusable(&error);
                State::Unusable(error)
            }
            Err(other) => return Err(other),
        };
        Ok(Store { root: root.to_path_buf(), state })
    }

    pub fn db_path(&self) -> PathBuf {
        self.root.join(db::DB_FILE)
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.root.join(backup::BACKUP_DIR)
    }

    pub fn status(&mut self) -> Result<StoreStatus> {
        match &mut self.state {
            State::Open { conn, .. } => Ok(StoreStatus::Ready { migration: import::migration_state(conn)? }),
            State::Unusable(StoreError::Off) => Err(StoreError::Off),
            State::Unusable(StoreError::SchemaTooNew { migration }) => {
                Ok(StoreStatus::TooNew { migration: migration.clone() })
            }
            State::Unusable(StoreError::Missing { detail }) => Ok(StoreStatus::Missing {
                detail: detail.clone(),
                backups: backup::verified(&self.backup_dir())?.iter().map(|b| b.at).collect(),
            }),
            State::Unusable(error) => Ok(StoreStatus::Damaged {
                detail: error.to_string(),
                backups: backup::verified(&self.backup_dir())?.iter().map(|b| b.at).collect(),
            }),
        }
    }

    /// Run `read` on the open database; damage found on the way makes the
    /// store unusable from here on.
    fn read<T>(&mut self, read: impl FnOnce(&mut SqliteConnection) -> Result<T>) -> Result<T> {
        let State::Open { conn, .. } = &mut self.state else { return Err(self.refusal()) };
        let result = read(conn);
        self.note(&result);
        result
    }

    fn write<T>(&mut self, write: impl FnOnce(&mut SqliteConnection) -> Result<T>) -> Result<T> {
        let State::Open { conn, writes, .. } = &mut self.state else { return Err(self.refusal()) };
        let result = write(conn);
        if result.is_ok() {
            *writes += 1;
        }
        self.note(&result);
        result
    }

    fn note<T>(&mut self, result: &Result<T>) {
        if let Err(error) = result {
            if error.is_damage() {
                log_unusable(error);
                self.state = State::Unusable(error.clone());
            }
        }
    }

    fn refusal(&self) -> StoreError {
        match &self.state {
            State::Unusable(error) => error.clone(),
            State::Open { .. } => StoreError::Invalid { detail: "store is open".into() },
        }
    }

    pub fn load_workspace(&mut self, workspace: &str) -> Result<Option<StoredBoard>> {
        self.read(|conn| board::load_workspace(conn, workspace))
    }

    pub fn load(&mut self, board_id: &str) -> Result<StoredBoard> {
        self.read(|conn| board::load(conn, board_id))
    }

    /// Every board, attached or not — what a migration is read back as.
    pub fn load_all(&mut self) -> Result<Vec<StoredBoard>> {
        self.read(|conn| {
            use diesel::prelude::*;
            let ids: Vec<String> =
                schema::boards::table.select(schema::boards::board).order(schema::boards::board).load(conn)?;
            ids.iter().map(|id| board::load(conn, id)).collect()
        })
    }

    pub fn apply(&mut self, change: &ChangeSet) -> Result<Applied> {
        self.require_active()?;
        self.write(|conn| board::apply(conn, change))
    }

    pub fn search(&mut self, query: &str, boards: &[String], limit: i64) -> Result<Vec<SearchHit>> {
        self.read(|conn| search::search(conn, query, boards, limit))
    }

    pub fn drop_workspace(&mut self, workspace: &str) -> Result<bool> {
        self.write(|conn| board::drop_workspace(conn, workspace))
    }

    fn require_active(&mut self) -> Result<()> {
        match self.read(import::migration_state)? {
            MigrationState::Active => Ok(()),
            _ => Err(StoreError::Invalid { detail: "the boards have not moved to the database yet".into() }),
        }
    }

    pub fn migration_state(&mut self) -> Result<MigrationState> {
        self.read(import::migration_state)
    }

    pub fn migration_sources(&mut self) -> Result<Vec<MigrationSource>> {
        self.read(import::migration_sources)
    }

    pub fn import(&mut self, boards: &[StoredBoard], sources: &[MigrationSource]) -> Result<()> {
        self.write(|conn| import::import(conn, boards, sources))
    }

    pub fn activate_migration(&mut self) -> Result<()> {
        self.write(import::activate)
    }

    pub fn discard_migration(&mut self) -> Result<()> {
        self.write(import::discard)
    }

    /// Whether a backup is due (none yet, or the newest older than an hour
    /// while the boards changed) — decided under the store's lock, with the
    /// database checked first so damage is never copied into a good slot.
    /// The copy itself is the job's, taken without the lock: the store's
    /// writes never wait on it. Never from a store that is not open.
    pub fn backup_due(&mut self, now_ms: i64) -> Result<Option<BackupJob>> {
        let State::Open { writes, backed_up, .. } = &self.state else { return Ok(None) };
        let writes = *writes;
        if !backup::due(&self.backup_dir(), now_ms, writes != *backed_up)? {
            return Ok(None);
        }
        self.read(db::quick_check)?;
        Ok(Some(BackupJob { db_path: self.db_path(), dir: self.backup_dir(), at: now_ms, writes }))
    }

    /// A job's backup is in the set: what it copied is backed up — the
    /// writes that landed while it copied are not.
    pub fn backup_taken(&mut self, job: &BackupJob) {
        if let State::Open { backed_up, .. } = &mut self.state {
            *backed_up = job.writes;
        }
    }

    /// Restore from the backup taken at `at`: copied beside the database
    /// and checked there, and only then put in its place, the damaged files
    /// aside. A failure on the way leaves the store as it was.
    pub fn restore_backup(&mut self, at: i64, now_ms: i64) -> Result<()> {
        self.require_restorable()?;
        let chosen = backup::verified(&self.backup_dir())?
            .into_iter()
            .find(|backup| backup.at == at)
            .ok_or_else(|| StoreError::Invalid { detail: format!("no verified backup taken at {at}") })?;
        let staged = db::staged_path(&self.db_path());
        db::stage(&staged, |to| db::copy_durably(&chosen.path, to))?;
        self.replace_with(&staged, now_ms)
    }

    /// Start over with a new database — the person's choice when there is
    /// no backup to restore. What was there goes aside, never deleted. The
    /// new one has had no move yet: boards still in their files move into
    /// it, and the boards held in the session are written into it after.
    pub fn start_empty(&mut self, now_ms: i64) -> Result<()> {
        self.require_restorable()?;
        let staged = db::staged_path(&self.db_path());
        db::stage(&staged, |path| {
            let mut conn = db::open(path)?;
            db::checkpoint(&mut conn)
        })?;
        self.replace_with(&staged, now_ms)
    }

    /// Only a database that cannot be used is replaced: a healthy one is
    /// never put aside, and a newer build's is that build's.
    fn require_restorable(&self) -> Result<()> {
        match &self.state {
            State::Unusable(StoreError::Corrupt { .. } | StoreError::Missing { .. }) => Ok(()),
            State::Unusable(error @ StoreError::Off) => Err(error.clone()),
            _ => Err(StoreError::Invalid { detail: "only a damaged or missing task database is replaced".into() }),
        }
    }

    fn replace_with(&mut self, staged: &Path, now_ms: i64) -> Result<()> {
        db::replace(&self.db_path(), staged, now_ms)?;
        match db::open(&self.db_path()) {
            Ok(conn) => {
                self.state = State::Open { conn, writes: 1, backed_up: 0 };
                Ok(())
            }
            Err(error) => {
                log_unusable(&error);
                self.state = State::Unusable(error.clone());
                Err(error)
            }
        }
    }

    /// Close the database, its log folded into the main file.
    pub fn close(&mut self) {
        if let State::Open { conn, .. } = &mut self.state {
            if let Err(error) = db::checkpoint(conn) {
                log::warn!("tasks: checkpoint on close failed: {error}");
            }
        }
        self.state = State::Unusable(StoreError::Off);
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        self.close();
    }
}

/// Whether the database changed after its newest backup was taken (by
/// the files' times: the main file and its log). No backup: due anyway.
fn newer_than_backups(path: &Path, root: &Path) -> bool {
    let Ok(Some(newest)) = backup::list(&root.join(backup::BACKUP_DIR)).map(|b| b.into_iter().next()) else { return false };
    let modified = |file: &Path| {
        let at = std::fs::metadata(file).and_then(|m| m.modified()).ok()?;
        at.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
    };
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    [modified(path), modified(Path::new(&wal))].into_iter().flatten().any(|at| at > newest.at)
}

/// What says this root held a database before — so a missing file is a
/// loss to resolve, not a first launch: a backup, or a copy set aside.
fn earlier_data(root: &Path) -> Result<Option<String>> {
    let backups = backup::list(&root.join(backup::BACKUP_DIR))?;
    if !backups.is_empty() {
        return Ok(Some(format!("{} of its backups are still there", backups.len())));
    }
    let entries = std::fs::read_dir(root).map_err(|e| StoreError::Io { detail: format!("reading {}: {e}", root.display()) })?;
    let aside = entries
        .filter_map(|entry| entry.ok())
        .any(|entry| entry.file_name().to_string_lossy().starts_with(db::ASIDE_PREFIX));
    Ok(aside.then(|| "a copy of it set aside is still there".to_string()))
}

fn log_unusable(error: &StoreError) {
    log::error!("tasks: the database is not usable — {error}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn damage_found_mid_session_makes_the_store_refuse_from_then_on() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        // A read that met damage — whatever the operation was.
        let met: Result<()> = Err(StoreError::Corrupt { detail: "page 3".into() });
        store.note(&met);
        assert!(matches!(store.load_workspace("ws-1"), Err(StoreError::Corrupt { .. })));
        assert!(matches!(store.status().unwrap(), StoreStatus::Damaged { .. }));
        assert!(store.backup_due(i64::MAX).unwrap().is_none());
        // A transient failure is no damage: the store stays open.
        let mut fresh = Store::open(tempfile::tempdir().unwrap().path()).unwrap();
        fresh.note(&Err::<(), _>(StoreError::DiskFull));
        assert!(fresh.load_workspace("ws-1").unwrap().is_none());
    }
}
