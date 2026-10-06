//! Writing whole boards into the database at once — the migration from
//! the JSON files.
//!
//! The migration is ONE step for every board (the user's rule: no state
//! where some boards live in the database and some in files). It lands as
//! `pending`; the TS owner reads it back, compares it with what it read
//! from the files, and only then makes it `active` — or throws it away.

use diesel::prelude::*;

use crate::error::{Result, StoreError};
use crate::meta;
use crate::model::StoredBoard;
use crate::rows::*;
use crate::schema::*;
use crate::search;

const STATE_KEY: &str = "migration";
const SOURCE_PREFIX: &str = "migration_source:";

/// Where the move from the JSON files stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub enum MigrationState {
    /// Nothing imported: the files are the boards' source.
    None,
    /// Imported, not yet verified: the files are still the source.
    Pending,
    /// Verified: the database is the source.
    Active,
}

pub fn migration_state(conn: &mut SqliteConnection) -> Result<MigrationState> {
    Ok(match meta::get(conn, STATE_KEY)?.as_deref() {
        None => MigrationState::None,
        Some("pending") => MigrationState::Pending,
        Some("active") => MigrationState::Active,
        Some(other) => return Err(StoreError::Corrupt { detail: format!("migration state {other:?}") }),
    })
}

/// One source file and its checksum, kept with a pending import so a file
/// that changed before the import was verified is noticed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct MigrationSource {
    pub workspace: String,
    pub checksum: String,
}

/// A board file the migration reads: its workspace, its bytes, and their
/// checksum (so a file that changes before the import is verified is seen).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct LegacyBoard {
    pub workspace: String,
    pub json: String,
    pub checksum: String,
}

/// Import every board in one transaction, as `pending`. Refused unless the
/// database holds no boards yet: a migration never lands on top of data.
pub fn import(conn: &mut SqliteConnection, boards_in: &[StoredBoard], sources: &[MigrationSource]) -> Result<()> {
    conn.immediate_transaction(|conn| {
        if migration_state(conn)? != MigrationState::None {
            return Err(StoreError::Invalid { detail: "a migration is already imported".into() });
        }
        let any = diesel::select(diesel::dsl::exists(boards::table.select(boards::board))).get_result::<bool>(conn)?;
        if any {
            return Err(StoreError::Invalid { detail: "the database already holds boards".into() });
        }
        write_boards(conn, boards_in)?;
        for source in sources {
            meta::set(conn, &format!("{SOURCE_PREFIX}{}", source.workspace), &source.checksum)?;
        }
        meta::set(conn, STATE_KEY, "pending")
    })
}

/// The sources a pending import was taken from.
pub fn migration_sources(conn: &mut SqliteConnection) -> Result<Vec<MigrationSource>> {
    Ok(meta::with_prefix(conn, SOURCE_PREFIX)?
        .into_iter()
        .map(|(workspace, checksum)| MigrationSource { workspace, checksum })
        .collect())
}

/// The import was read back and found equal: the database is the source.
pub fn activate(conn: &mut SqliteConnection) -> Result<()> {
    conn.immediate_transaction(|conn| {
        if migration_state(conn)? != MigrationState::Pending {
            return Err(StoreError::Invalid { detail: "no pending migration to activate".into() });
        }
        meta::set(conn, STATE_KEY, "active")?;
        meta::delete_prefix(conn, SOURCE_PREFIX)
    })
}

/// Throw a pending import away whole — it did not read back equal, or its
/// files changed before it was verified.
pub fn discard(conn: &mut SqliteConnection) -> Result<()> {
    conn.immediate_transaction(|conn| {
        if migration_state(conn)? != MigrationState::Pending {
            return Err(StoreError::Invalid { detail: "no pending migration to discard".into() });
        }
        diesel::delete(relations::table).execute(conn)?;
        diesel::delete(requests::table).execute(conn)?;
        diesel::delete(boards::table).execute(conn)?;
        search::forget_all(conn)?;
        meta::delete(conn, STATE_KEY)?;
        meta::delete_prefix(conn, SOURCE_PREFIX)
    })
}

/// Write boards whole into an empty database. Every refusal says what and
/// where.
fn write_boards(conn: &mut SqliteConnection, boards_in: &[StoredBoard]) -> Result<()> {
    let board_rows: Vec<BoardRow> = boards_in
        .iter()
        .map(|b| BoardRow { board: b.board.clone(), workspace: b.workspace.clone(), next_id: b.next_id, rev: b.rev })
        .collect();
    diesel::insert_into(boards::table).values(&board_rows).execute(conn).map_err(|e| named(e, "a board".into()))?;
    for board in boards_in {
        for (pos, task) in board.tasks.iter().enumerate() {
            let what = |thing: String| format!("task {} on board {}: {thing}", task.key, board.board);
            diesel::insert_into(tasks::table)
                .values(&TaskRow {
                    uid: task.uid.clone(),
                    board: board.board.clone(),
                    board_pos: pos as i64,
                    team_id: task.team_id.clone(),
                    title: task.title.clone(),
                    body: task.body.clone(),
                    body_v: task.body_v,
                    status: task.status.clone(),
                    priority: task.priority.clone(),
                    assignee: task.assignee.clone(),
                    author: task.author.clone(),
                    created: task.created,
                    updated: task.updated,
                    rev: task.rev,
                })
                .execute(conn)
                .map_err(|e| named(e, what(format!("uid {}", task.uid))))?;
            let mut keys = vec![KeyRow { board: board.board.clone(), id: task.key.clone(), uid: task.uid.clone(), current: true }];
            keys.extend(task.old_keys.iter().map(|k| KeyRow {
                board: k.board.clone(),
                id: k.id.clone(),
                uid: task.uid.clone(),
                current: false,
            }));
            diesel::insert_into(task_keys::table).values(&keys).execute(conn).map_err(|e| named(e, what("an address".into())))?;
            if !task.labels.is_empty() {
                let rows: Vec<LabelRow> =
                    task.labels.iter().map(|l| LabelRow { uid: task.uid.clone(), label: l.clone() }).collect();
                diesel::insert_into(task_labels::table).values(&rows).execute(conn).map_err(|e| named(e, what("a label".into())))?;
            }
            if !task.artifacts.is_empty() {
                let rows: Vec<ArtifactRow> = task
                    .artifacts
                    .iter()
                    .enumerate()
                    .map(|(pos, a)| ArtifactRow { uid: task.uid.clone(), pos: pos as i64, artifact: a.clone() })
                    .collect();
                diesel::insert_into(task_artifacts::table).values(&rows).execute(conn)?;
            }
            for c in &task.comments {
                diesel::insert_into(task_comments::table)
                    .values(&CommentRow { uid: task.uid.clone(), n: c.n, at: c.at, author: c.author.clone(), body: c.body.clone() })
                    .execute(conn)
                    .map_err(|e| named(e, what(format!("comment {}", c.n))))?;
                search::index_comment(conn, &task.uid, c.n, &c.body)?;
            }
            for (seq, e) in task.log.iter().enumerate() {
                if e.seq != seq as i64 {
                    return Err(StoreError::Invalid { detail: what(format!("log entry {seq} is numbered {}", e.seq)) });
                }
                diesel::insert_into(task_log::table)
                    .values(&LogRow {
                        uid: task.uid.clone(),
                        seq: e.seq,
                        at: e.at,
                        author: e.author.clone(),
                        field: e.field.clone(),
                        was: e.was.clone(),
                        now: e.now.clone(),
                    })
                    .execute(conn)?;
            }
            for b in &task.briefs {
                diesel::insert_into(task_briefs::table)
                    .values(&BriefRow { uid: task.uid.clone(), v: b.v, body: b.body.clone() })
                    .execute(conn)
                    .map_err(|e| named(e, what(format!("brief version {}", b.v))))?;
            }
            search::index_task(conn, &task.uid, &task.title, &task.body)?;
        }
        for r in &board.relations {
            diesel::insert_into(relations::table)
                .values(&RelationRow { kind: r.kind.clone(), from_uid: r.from.clone(), to_uid: r.to.clone(), at: r.at, by: r.by.clone() })
                .execute(conn)
                .map_err(|e| named(e, format!("link {} {} → {} on board {}", r.kind, r.from, r.to, board.board)))?;
        }
    }
    Ok(())
}

/// A constraint the import hit, said with what and where — never SQLite's
/// bare text alone.
fn named(error: diesel::result::Error, what: String) -> StoreError {
    match StoreError::from(error) {
        StoreError::Constraint { detail } => StoreError::Constraint { detail: format!("{what}: {detail}") },
        other => other,
    }
}
