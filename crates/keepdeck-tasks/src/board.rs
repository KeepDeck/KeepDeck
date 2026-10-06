//! Reading a board whole, and applying a change to the boards as one
//! transaction.
//!
//! The rules here are the STORE's — what the disk must guarantee — never a
//! rule about what a task means: the domain decides what changed; this
//! writes it so that a change lands whole or not at all, is never applied
//! twice, never takes a number back, and never deletes a line of history.

use std::collections::{HashMap, HashSet};

use diesel::prelude::*;

use crate::error::{Result, StoreError};
use crate::model::*;
use crate::rows::*;
use crate::schema::*;
use crate::search;

/// How many applied requests are remembered for answering a repeat.
const REQUESTS_KEPT: i64 = 500;

/// The board of a workspace, or `None` when the workspace has none yet.
pub fn load_workspace(conn: &mut SqliteConnection, workspace: &str) -> Result<Option<StoredBoard>> {
    let board: Option<String> =
        boards::table.filter(boards::workspace.eq(workspace)).select(boards::board).first(conn).optional()?;
    match board {
        Some(board) => load(conn, &board).map(Some),
        None => Ok(None),
    }
}

/// One board whole: its tasks in board order, each with everything it holds,
/// and its links.
pub fn load(conn: &mut SqliteConnection, board: &str) -> Result<StoredBoard> {
    let stored: BoardRow = boards::table
        .find(board)
        .select(BoardRow::as_select())
        .first(conn)
        .optional()?
        .ok_or_else(|| StoreError::Invalid { detail: format!("no board {board}") })?;

    let rows: Vec<TaskRow> = tasks::table
        .filter(tasks::board.eq(board))
        .order(tasks::board_pos)
        .select(TaskRow::as_select())
        .load(conn)?;
    let mut at: HashMap<String, usize> = HashMap::with_capacity(rows.len());
    let mut out: Vec<StoredTask> = Vec::with_capacity(rows.len());
    for row in rows {
        at.insert(row.uid.clone(), out.len());
        out.push(StoredTask {
            uid: row.uid,
            key: String::new(),
            old_keys: Vec::new(),
            team_id: row.team_id,
            title: row.title,
            body: row.body,
            body_v: row.body_v,
            status: row.status,
            priority: row.priority,
            assignee: row.assignee,
            author: row.author,
            created: row.created,
            updated: row.updated,
            rev: row.rev,
            labels: Vec::new(),
            artifacts: Vec::new(),
            comments: Vec::new(),
            log: Vec::new(),
            briefs: Vec::new(),
        });
    }
    let on_board = tasks::table.filter(tasks::board.eq(board)).select(tasks::uid);

    let keys: Vec<KeyRow> = task_keys::table
        .filter(task_keys::uid.eq_any(on_board))
        .order((task_keys::board, task_keys::id))
        .select(KeyRow::as_select())
        .load(conn)?;
    for key in keys {
        if let Some(&i) = at.get(&key.uid) {
            if key.current && key.board == board {
                out[i].key = key.id;
            } else {
                out[i].old_keys.push(StoredKey { board: key.board, id: key.id });
            }
        }
    }
    let labels: Vec<LabelRow> = task_labels::table
        .filter(task_labels::uid.eq_any(on_board))
        .order((task_labels::uid, task_labels::label))
        .select(LabelRow::as_select())
        .load(conn)?;
    for label in labels {
        if let Some(&i) = at.get(&label.uid) {
            out[i].labels.push(label.label);
        }
    }
    let artifacts: Vec<ArtifactRow> = task_artifacts::table
        .filter(task_artifacts::uid.eq_any(on_board))
        .order((task_artifacts::uid, task_artifacts::pos))
        .select(ArtifactRow::as_select())
        .load(conn)?;
    for artifact in artifacts {
        if let Some(&i) = at.get(&artifact.uid) {
            out[i].artifacts.push(artifact.artifact);
        }
    }
    let comments: Vec<CommentRow> = task_comments::table
        .filter(task_comments::uid.eq_any(on_board))
        .order((task_comments::uid, task_comments::n))
        .select(CommentRow::as_select())
        .load(conn)?;
    for c in comments {
        if let Some(&i) = at.get(&c.uid) {
            out[i].comments.push(StoredComment { n: c.n, at: c.at, author: c.author, body: c.body });
        }
    }
    let log: Vec<LogRow> = task_log::table
        .filter(task_log::uid.eq_any(on_board))
        .order((task_log::uid, task_log::seq))
        .select(LogRow::as_select())
        .load(conn)?;
    for e in log {
        if let Some(&i) = at.get(&e.uid) {
            out[i].log.push(StoredLogEntry { seq: e.seq, at: e.at, author: e.author, field: e.field, was: e.was, now: e.now });
        }
    }
    let briefs: Vec<BriefRow> = task_briefs::table
        .filter(task_briefs::uid.eq_any(on_board))
        .order((task_briefs::uid, task_briefs::v))
        .select(BriefRow::as_select())
        .load(conn)?;
    for b in briefs {
        if let Some(&i) = at.get(&b.uid) {
            out[i].briefs.push(StoredBrief { v: b.v, body: b.body });
        }
    }
    // A link is its `from` end's board's. One whose `from` end is gone from
    // every board — kept by the domain while its other end lives — is the
    // board of its `to` end.
    let anywhere = tasks::table.select(tasks::uid);
    let links: Vec<RelationRow> = relations::table
        .filter(
            relations::from_uid
                .eq_any(on_board)
                .or(relations::from_uid.ne_all(anywhere).and(relations::to_uid.eq_any(on_board))),
        )
        .order((relations::kind, relations::from_uid, relations::to_uid))
        .select(RelationRow::as_select())
        .load(conn)?;

    if let Some(task) = out.iter().find(|task| task.key.is_empty()) {
        return Err(StoreError::Corrupt { detail: format!("task {} has no current address on board {board}", task.uid) });
    }
    Ok(StoredBoard {
        board: stored.board,
        workspace: stored.workspace,
        next_id: stored.next_id,
        rev: stored.rev,
        tasks: out,
        relations: links
            .into_iter()
            .map(|r| StoredRelation { kind: r.kind, from: r.from_uid, to: r.to_uid, at: r.at, by: r.by })
            .collect(),
    })
}

/// Apply one change to the boards: every board it touches moves together,
/// or none does.
pub fn apply(conn: &mut SqliteConnection, change: &ChangeSet) -> Result<Applied> {
    if change.request_id.is_empty() {
        return Err(StoreError::Invalid { detail: "a change needs a request id".into() });
    }
    conn.immediate_transaction(|conn| {
        // Sent again after its answer was lost: answered, never applied twice.
        let before = applied_revs(conn, &change.request_id)?;
        if !before.is_empty() {
            return Ok(Applied::AlreadyApplied { revs: before });
        }
        let mut in_change = HashSet::new();
        for board_change in &change.boards {
            if !in_change.insert(board_change.board.as_str()) {
                return Err(StoreError::Invalid { detail: format!("board {} twice in one change", board_change.board) });
            }
        }
        let mut revs = Vec::with_capacity(change.boards.len());
        for board_change in &change.boards {
            revs.push(apply_board(conn, board_change, &in_change)?);
        }
        remember(conn, &change.request_id, &revs)?;
        Ok(Applied::Applied { revs })
    })
}

fn applied_revs(conn: &mut SqliteConnection, request_id: &str) -> Result<Vec<BoardRev>> {
    let rows: Vec<(String, i64)> = requests::table
        .filter(requests::request_id.eq(request_id))
        .order(requests::board)
        .select((requests::board, requests::rev))
        .load(conn)?;
    Ok(rows.into_iter().map(|(board, rev)| BoardRev { board, rev }).collect())
}

fn remember(conn: &mut SqliteConnection, request_id: &str, revs: &[BoardRev]) -> Result<()> {
    let last: Option<i64> = requests::table.select(diesel::dsl::max(requests::seq)).first(conn)?;
    let seq = last.unwrap_or(0) + 1;
    let rows: Vec<RequestRow> = revs
        .iter()
        .map(|rev| RequestRow { request_id: request_id.to_string(), board: rev.board.clone(), rev: rev.rev, seq })
        .collect();
    diesel::insert_into(requests::table).values(&rows).execute(conn)?;
    diesel::delete(requests::table.filter(requests::seq.le(seq - REQUESTS_KEPT))).execute(conn)?;
    Ok(())
}

fn apply_board(conn: &mut SqliteConnection, change: &BoardChange, in_change: &HashSet<&str>) -> Result<BoardRev> {
    let stored: Option<BoardRow> =
        boards::table.find(&change.board).select(BoardRow::as_select()).first(conn).optional()?;
    let (next_id, rev) = match stored {
        None => {
            if change.expected_rev != 0 {
                return Err(StoreError::Conflict { board: change.board.clone(), rev: 0 });
            }
            diesel::insert_into(boards::table)
                .values(&BoardRow {
                    board: change.board.clone(),
                    workspace: change.workspace.clone(),
                    next_id: change.next_id,
                    rev: 0,
                })
                .execute(conn)?;
            (change.next_id, 0)
        }
        Some(row) => {
            if row.rev != change.expected_rev {
                return Err(StoreError::Conflict { board: change.board.clone(), rev: row.rev });
            }
            if change.workspace.is_some() && change.workspace != row.workspace {
                return Err(StoreError::Invalid { detail: format!("board {} belongs to another workspace", change.board) });
            }
            (row.next_id, row.rev)
        }
    };
    if change.next_id < next_id {
        return Err(StoreError::Constraint {
            detail: format!("board {}: the counter would go back from {next_id} to {}", change.board, change.next_id),
        });
    }
    let new_rev = rev + 1;

    for uid in &change.removed {
        let gone = diesel::delete(tasks::table.filter(tasks::uid.eq(uid)).filter(tasks::board.eq(&change.board)))
            .execute(conn)?;
        if gone == 0 {
            return Err(StoreError::Invalid { detail: format!("task {uid} is not on board {}", change.board) });
        }
        search::forget_task(conn, uid)?;
    }
    for task in &change.tasks {
        write_task(conn, &change.board, new_rev, task, in_change)?;
    }
    for key in &change.relations_removed {
        diesel::delete(relations::table.find((&key.kind, &key.from, &key.to))).execute(conn)?;
    }
    for relation in &change.relations_put {
        let row = RelationRow {
            kind: relation.kind.clone(),
            from_uid: relation.from.clone(),
            to_uid: relation.to.clone(),
            at: relation.at,
            by: relation.by.clone(),
        };
        diesel::insert_into(relations::table)
            .values(&row)
            .on_conflict((relations::kind, relations::from_uid, relations::to_uid))
            .do_update()
            .set((relations::at.eq(row.at), relations::by.eq(&row.by)))
            .execute(conn)?;
    }
    // Board order is the domain's: every task holds a place of its own.
    let clash: Option<i64> = tasks::table
        .filter(tasks::board.eq(&change.board))
        .group_by(tasks::board_pos)
        .having(diesel::dsl::count_star().gt(1))
        .select(tasks::board_pos)
        .first(conn)
        .optional()?;
    if let Some(pos) = clash {
        return Err(StoreError::Constraint { detail: format!("board {}: two tasks at place {pos}", change.board) });
    }
    diesel::update(boards::table.find(&change.board))
        .set((boards::next_id.eq(change.next_id), boards::rev.eq(new_rev)))
        .execute(conn)?;
    Ok(BoardRev { board: change.board.clone(), rev: new_rev })
}

fn write_task(conn: &mut SqliteConnection, board: &str, rev: i64, task: &TaskWrite, in_change: &HashSet<&str>) -> Result<()> {
    let lives_on: Option<String> = tasks::table.find(&task.uid).select(tasks::board).first(conn).optional()?;
    // A task leaves its board only in a change that names that board too:
    // its rev is checked, and it moves on with the task gone from it.
    if let Some(from) = lives_on.as_deref().filter(|from| *from != board && !in_change.contains(from)) {
        return Err(StoreError::Constraint {
            detail: format!("task {} lives on board {from} — a move to board {board} names both boards", task.uid),
        });
    }
    let existed = lives_on.is_some();
    let row = TaskRow {
        uid: task.uid.clone(),
        board: board.to_string(),
        board_pos: task.board_pos,
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
        rev,
    };
    diesel::insert_into(tasks::table).values(&row).on_conflict(tasks::uid).do_update().set(&row).execute(conn)?;

    match &task.key {
        Some(id) => {
            diesel::update(task_keys::table.filter(task_keys::uid.eq(&task.uid)).filter(task_keys::current.eq(true)))
                .set(task_keys::current.eq(false))
                .execute(conn)?;
            diesel::insert_into(task_keys::table)
                .values(&KeyRow { board: board.to_string(), id: id.clone(), uid: task.uid.clone(), current: true })
                .execute(conn)
                .map_err(|e| key_taken(e, board, id))?;
        }
        None if !existed => {
            return Err(StoreError::Invalid { detail: format!("new task {} has no address", task.uid) });
        }
        None => {
            // Staying where it is: its current address must be on this board.
            let here = diesel::select(diesel::dsl::exists(
                task_keys::table
                    .filter(task_keys::uid.eq(&task.uid))
                    .filter(task_keys::current.eq(true))
                    .filter(task_keys::board.eq(board)),
            ))
            .get_result::<bool>(conn)?;
            if !here {
                return Err(StoreError::Invalid {
                    detail: format!("task {} moved to board {board} without a new address", task.uid),
                });
            }
        }
    }
    if let Some(labels) = &task.labels {
        diesel::delete(task_labels::table.filter(task_labels::uid.eq(&task.uid))).execute(conn)?;
        let rows: Vec<LabelRow> =
            labels.iter().map(|label| LabelRow { uid: task.uid.clone(), label: label.clone() }).collect();
        if !rows.is_empty() {
            diesel::insert_into(task_labels::table).values(&rows).execute(conn)?;
        }
    }
    if let Some(artifacts) = &task.artifacts {
        diesel::delete(task_artifacts::table.filter(task_artifacts::uid.eq(&task.uid))).execute(conn)?;
        let rows: Vec<ArtifactRow> = artifacts
            .iter()
            .enumerate()
            .map(|(pos, artifact)| ArtifactRow { uid: task.uid.clone(), pos: pos as i64, artifact: artifact.clone() })
            .collect();
        if !rows.is_empty() {
            diesel::insert_into(task_artifacts::table).values(&rows).execute(conn)?;
        }
    }
    for comment in &task.comments {
        append_comment(conn, &task.uid, comment)?;
    }
    for entry in &task.log {
        append_log(conn, &task.uid, entry)?;
    }
    for brief in &task.briefs {
        append_brief(conn, &task.uid, brief)?;
    }
    search::index_task(conn, &task.uid, &task.title, &task.body)
}

fn key_taken(error: diesel::result::Error, board: &str, id: &str) -> StoreError {
    match StoreError::from(error) {
        StoreError::Constraint { .. } => StoreError::Constraint {
            detail: format!("{id} on board {board} is already an address — numbers are never handed out twice"),
        },
        other => other,
    }
}

/// History is appended, never rewritten: a row already stored is either
/// sent again exactly (no change) or a contradiction.
fn append_comment(conn: &mut SqliteConnection, uid: &str, comment: &StoredComment) -> Result<()> {
    let row = CommentRow {
        uid: uid.to_string(),
        n: comment.n,
        at: comment.at,
        author: comment.author.clone(),
        body: comment.body.clone(),
    };
    let stored: Option<CommentRow> =
        task_comments::table.find((uid, comment.n)).select(CommentRow::as_select()).first(conn).optional()?;
    match stored {
        Some(stored) if stored == row => Ok(()),
        Some(_) => Err(StoreError::Constraint { detail: format!("task {uid}: comment {} is stored with other content", comment.n) }),
        None => {
            diesel::insert_into(task_comments::table).values(&row).execute(conn)?;
            search::index_comment(conn, uid, comment.n, &comment.body)
        }
    }
}

fn append_log(conn: &mut SqliteConnection, uid: &str, entry: &StoredLogEntry) -> Result<()> {
    let row = LogRow {
        uid: uid.to_string(),
        seq: entry.seq,
        at: entry.at,
        author: entry.author.clone(),
        field: entry.field.clone(),
        was: entry.was.clone(),
        now: entry.now.clone(),
    };
    let stored: Option<LogRow> =
        task_log::table.find((uid, entry.seq)).select(LogRow::as_select()).first(conn).optional()?;
    match stored {
        Some(stored) if stored == row => Ok(()),
        Some(_) => Err(StoreError::Constraint { detail: format!("task {uid}: log entry {} is stored with other content", entry.seq) }),
        None => {
            // A log grows at its end only: every entry before it is there.
            let count: i64 = task_log::table.filter(task_log::uid.eq(uid)).count().get_result(conn)?;
            if entry.seq != count {
                return Err(StoreError::Constraint {
                    detail: format!("task {uid}: log entry {} would leave a gap (the log has {count})", entry.seq),
                });
            }
            diesel::insert_into(task_log::table).values(&row).execute(conn)?;
            Ok(())
        }
    }
}

fn append_brief(conn: &mut SqliteConnection, uid: &str, brief: &StoredBrief) -> Result<()> {
    let row = BriefRow { uid: uid.to_string(), v: brief.v, body: brief.body.clone() };
    let stored: Option<BriefRow> =
        task_briefs::table.find((uid, brief.v)).select(BriefRow::as_select()).first(conn).optional()?;
    match stored {
        Some(stored) if stored == row => Ok(()),
        Some(_) => Err(StoreError::Constraint { detail: format!("task {uid}: brief version {} is stored with other content", brief.v) }),
        None => {
            diesel::insert_into(task_briefs::table).values(&row).execute(conn)?;
            Ok(())
        }
    }
}

/// Drop a workspace's board and everything on it. Links leaving its tasks
/// go with them; links from elsewhere INTO them stay, their far end gone —
/// what becomes of those is the domain's rule.
pub fn drop_workspace(conn: &mut SqliteConnection, workspace: &str) -> Result<bool> {
    conn.immediate_transaction(|conn| {
        let board: Option<String> =
            boards::table.filter(boards::workspace.eq(workspace)).select(boards::board).first(conn).optional()?;
        let Some(board) = board else { return Ok(false) };
        let on_board: Vec<String> = tasks::table.filter(tasks::board.eq(&board)).select(tasks::uid).load(conn)?;
        diesel::delete(relations::table.filter(relations::from_uid.eq_any(&on_board))).execute(conn)?;
        for uid in &on_board {
            search::forget_task(conn, uid)?;
        }
        diesel::delete(boards::table.find(&board)).execute(conn)?;
        Ok(true)
    })
}
