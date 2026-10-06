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
    /// Written by a newer KeepDeck: nothing is written.
    TooNew { migration: String },
}

enum State {
    Open { conn: SqliteConnection, changed_since_backup: bool },
    Unusable(StoreError),
}

/// The database of `<root>/tasks.db`, with its backups in `<root>/backups`.
pub struct Store {
    root: PathBuf,
    state: State,
}

impl Store {
    /// Open the store under `root`. A damaged or too-new database is no
    /// failure to open: the store opens in the state that says so.
    pub fn open(root: &Path) -> Result<Store> {
        std::fs::create_dir_all(root)
            .map_err(|e| StoreError::Io { detail: format!("creating {}: {e}", root.display()) })?;
        let path = root.join(db::DB_FILE);
        let state = match db::open(&path) {
            Ok(conn) => State::Open { conn, changed_since_backup: false },
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
            State::Unusable(StoreError::SchemaTooNew { migration }) => {
                Ok(StoreStatus::TooNew { migration: migration.clone() })
            }
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
        let State::Open { conn, changed_since_backup } = &mut self.state else { return Err(self.refusal()) };
        let result = write(conn);
        if result.is_ok() {
            *changed_since_backup = true;
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

    /// Take a backup when one is due (none yet, or the newest older than an
    /// hour while the boards changed). Never from a store that is not open.
    pub fn backup_if_due(&mut self, now_ms: i64) -> Result<Option<backup::Backup>> {
        let State::Open { changed_since_backup, .. } = &self.state else { return Ok(None) };
        let dir = self.backup_dir();
        if !backup::due(&dir, now_ms, *changed_since_backup)? {
            return Ok(None);
        }
        // The copy is taken on its own connection; this one is checked first,
        // so damage is never copied into a good slot.
        self.read(db::quick_check)?;
        let taken = backup::take(&self.db_path(), &dir, now_ms)?;
        if let State::Open { changed_since_backup, .. } = &mut self.state {
            *changed_since_backup = false;
        }
        Ok(Some(taken))
    }

    /// Restore from the backup taken at `at`: the damaged files go aside,
    /// the backup takes their place, and the store reopens on it.
    pub fn restore_backup(&mut self, at: i64, now_ms: i64) -> Result<()> {
        let chosen = backup::verified(&self.backup_dir())?
            .into_iter()
            .find(|backup| backup.at == at)
            .ok_or_else(|| StoreError::Invalid { detail: format!("no verified backup taken at {at}") })?;
        let path = self.db_path();
        self.close();
        db::set_aside(&path, now_ms)?;
        std::fs::copy(&chosen.path, &path)
            .map_err(|e| StoreError::Io { detail: format!("placing the backup: {e}") })?;
        self.reopen()
    }

    fn reopen(&mut self) -> Result<()> {
        let conn = db::open(&self.db_path())?;
        self.state = State::Open { conn, changed_since_backup: true };
        Ok(())
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
        assert!(store.backup_if_due(i64::MAX).unwrap().is_none());
        // A transient failure is no damage: the store stays open.
        let mut fresh = Store::open(tempfile::tempdir().unwrap().path()).unwrap();
        fresh.note(&Err::<(), _>(StoreError::DiskFull));
        assert!(fresh.load_workspace("ws-1").unwrap().is_none());
    }
}
