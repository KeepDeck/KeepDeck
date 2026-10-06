//! What can go wrong, as CODES the TS owner acts on — never a sentence it
//! would have to parse. The split that matters: whether a write may be
//! tried again, and whether the database itself is in doubt.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "code")]
#[ts(export, export_to = "tasks/")]
pub enum StoreError {
    /// Tasks are off — turn them on first.
    Off,
    /// Another opener holds the database (a DB browser, a backup tool):
    /// try again.
    Busy,
    /// No room on the disk: try again once there is.
    DiskFull,
    /// The disk refused (permissions, a vanished folder): try again.
    Io { detail: String },
    /// The change does not fit what is stored — a repeated number, a
    /// counter that would go back. Not tried again as it is.
    Constraint { detail: String },
    /// The change was computed against another state of a board.
    Conflict {
        board: String,
        #[ts(type = "number")]
        rev: i64,
    },
    /// One board's rows break the store's own invariants (a task with no
    /// current address): that board is not read. The database is sound —
    /// every other board reads and writes on.
    Inconsistent { board: String, detail: String },
    /// The database is damaged. Nothing is written until the person
    /// restores it.
    Corrupt { detail: String },
    /// The database file is gone though earlier data is still beside it
    /// (backups, a copy set aside): nothing is created over it in silence —
    /// the person restores a backup or starts empty.
    Missing { detail: String },
    /// A newer build wrote this database (a migration this build does not
    /// know); this one neither reads nor writes it.
    SchemaTooNew { migration: String },
    /// The request breaks the store's own rules (an unsafe name, a board
    /// that does not exist).
    Invalid { detail: String },
}

impl StoreError {
    /// Whether the database is in doubt: from here on the store is read-only
    /// and takes no backups.
    pub fn is_damage(&self) -> bool {
        matches!(self, StoreError::Corrupt { .. })
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Off => write!(f, "task board is off — turn Tasks on first"),
            StoreError::Busy => write!(f, "the task database is busy — another program has it open"),
            StoreError::DiskFull => write!(f, "the disk is full"),
            StoreError::Io { detail } => write!(f, "the disk refused: {detail}"),
            StoreError::Constraint { detail } => write!(f, "the change does not fit the stored board: {detail}"),
            StoreError::Conflict { board, rev } => write!(f, "board {board} changed meanwhile (now at {rev})"),
            StoreError::Inconsistent { board, detail } => write!(f, "board {board} does not hold together: {detail}"),
            StoreError::Corrupt { detail } => write!(f, "the task database is damaged: {detail}"),
            StoreError::Missing { detail } => write!(f, "the task database is missing, though {detail}"),
            StoreError::SchemaTooNew { migration } => {
                write!(f, "the task database was written by a newer KeepDeck (migration {migration})")
            }
            StoreError::Invalid { detail } => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<diesel::result::Error> for StoreError {
    fn from(error: diesel::result::Error) -> Self {
        use diesel::result::{DatabaseErrorKind as K, Error as E};
        match error {
            E::DatabaseError(K::UniqueViolation | K::ForeignKeyViolation | K::NotNullViolation | K::CheckViolation, info) => {
                StoreError::Constraint { detail: info.message().to_string() }
            }
            E::DatabaseError(_, info) => classify(info.message()),
            E::NotFound => StoreError::Invalid { detail: "not found".into() },
            // A row or a value this build cannot map: a bug, never the disk.
            e @ (E::DeserializationError(_) | E::SerializationError(_) | E::QueryBuilderError(_)) => {
                StoreError::Invalid { detail: e.to_string() }
            }
            other => classify(&other.to_string()),
        }
    }
}

impl From<diesel::ConnectionError> for StoreError {
    fn from(error: diesel::ConnectionError) -> Self {
        classify(&error.to_string())
    }
}

/// SQLite says what went wrong in words that do not change between
/// releases (`sqlite3_errstr`); Diesel hands them over as text (not the
/// extended code), so the class is read from them — the one place that
/// does. Only what the disk or another opener caused is worth trying
/// again; anything else — a statement SQLite refuses as written, a
/// message nobody listed — is `Invalid`, never retried as if it might pass.
fn classify(message: &str) -> StoreError {
    let m = message.to_ascii_lowercase();
    let detail = message.to_string();
    let any = |words: &[&str]| words.iter().any(|w| m.contains(w));
    if any(&["database disk image is malformed", "file is not a database", "not a database"]) {
        StoreError::Corrupt { detail }
    } else if any(&["database is locked", "database table is locked"]) {
        StoreError::Busy
    } else if any(&["database or disk is full", "disk is full"]) {
        StoreError::DiskFull
    } else if any(&["disk i/o error", "unable to open database file", "attempt to write a readonly database", "readonly database"]) {
        StoreError::Io { detail }
    } else if any(&["constraint failed", "datatype mismatch"]) {
        StoreError::Constraint { detail }
    } else {
        StoreError::Invalid { detail }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_words_map_to_what_the_owner_does_next() {
        let table: &[(&str, StoreError)] = &[
            ("database disk image is malformed", StoreError::Corrupt { detail: "database disk image is malformed".into() }),
            ("file is not a database", StoreError::Corrupt { detail: "file is not a database".into() }),
            ("database is locked", StoreError::Busy),
            ("database table is locked", StoreError::Busy),
            ("database or disk is full", StoreError::DiskFull),
            ("disk I/O error", StoreError::Io { detail: "disk I/O error".into() }),
            ("unable to open database file", StoreError::Io { detail: "unable to open database file".into() }),
            ("attempt to write a readonly database", StoreError::Io { detail: "attempt to write a readonly database".into() }),
            ("datatype mismatch", StoreError::Constraint { detail: "datatype mismatch".into() }),
            ("ROWID constraint failed", StoreError::Constraint { detail: "ROWID constraint failed".into() }),
            // Permanent: tried again they fail the same way.
            ("too many SQL variables", StoreError::Invalid { detail: "too many SQL variables".into() }),
            ("string or blob too big", StoreError::Invalid { detail: "string or blob too big".into() }),
            ("no such table: tasks", StoreError::Invalid { detail: "no such table: tasks".into() }),
            ("no such column: busy_flag", StoreError::Invalid { detail: "no such column: busy_flag".into() }),
        ];
        for (message, expected) in table {
            assert_eq!(&classify(message), expected, "{message}");
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;
