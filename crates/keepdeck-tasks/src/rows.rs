//! The rows of each table as Diesel reads and writes them — checked
//! against `schema.rs` (generated from the migrations) at compile time:
//! a column renamed, retyped or made nullable in a migration fails the
//! build here, not a query at run time.

use diesel::prelude::*;

use crate::schema::*;

#[derive(Queryable, Selectable, Insertable, AsChangeset, Debug, Clone, PartialEq)]
#[diesel(table_name = boards, check_for_backend(diesel::sqlite::Sqlite))]
pub struct BoardRow {
    pub board: String,
    pub workspace: Option<String>,
    pub next_id: i64,
    pub rev: i64,
}

#[derive(Queryable, Selectable, Insertable, AsChangeset, Debug, Clone, PartialEq)]
#[diesel(table_name = tasks, check_for_backend(diesel::sqlite::Sqlite), treat_none_as_null = true)]
pub struct TaskRow {
    pub uid: String,
    pub board: String,
    pub board_pos: i64,
    pub team_id: Option<String>,
    pub title: String,
    pub body: String,
    pub body_v: i64,
    pub status: String,
    pub priority: String,
    pub assignee: Option<String>,
    pub author: String,
    pub created: i64,
    pub updated: i64,
    pub rev: i64,
}

#[derive(Queryable, Selectable, Insertable, Debug, Clone, PartialEq)]
#[diesel(table_name = task_keys, check_for_backend(diesel::sqlite::Sqlite))]
pub struct KeyRow {
    pub board: String,
    pub id: String,
    pub uid: String,
    pub current: bool,
}

#[derive(Queryable, Selectable, Insertable, Debug, Clone, PartialEq)]
#[diesel(table_name = task_labels, check_for_backend(diesel::sqlite::Sqlite))]
pub struct LabelRow {
    pub uid: String,
    pub label: String,
}

#[derive(Queryable, Selectable, Insertable, Debug, Clone, PartialEq)]
#[diesel(table_name = task_artifacts, check_for_backend(diesel::sqlite::Sqlite))]
pub struct ArtifactRow {
    pub uid: String,
    pub pos: i64,
    pub artifact: String,
}

#[derive(Queryable, Selectable, Insertable, Debug, Clone, PartialEq)]
#[diesel(table_name = task_comments, check_for_backend(diesel::sqlite::Sqlite))]
pub struct CommentRow {
    pub uid: String,
    pub n: i64,
    pub at: i64,
    pub author: String,
    pub body: String,
}

#[derive(Queryable, Selectable, Insertable, Debug, Clone, PartialEq)]
#[diesel(table_name = task_log, check_for_backend(diesel::sqlite::Sqlite))]
pub struct LogRow {
    pub uid: String,
    pub seq: i64,
    pub at: i64,
    pub author: String,
    pub field: String,
    pub was: Option<String>,
    pub now: Option<String>,
}

#[derive(Queryable, Selectable, Insertable, Debug, Clone, PartialEq)]
#[diesel(table_name = task_briefs, check_for_backend(diesel::sqlite::Sqlite))]
pub struct BriefRow {
    pub uid: String,
    pub v: i64,
    pub at: i64,
    pub author: String,
    pub body: String,
}

#[derive(Queryable, Selectable, Insertable, AsChangeset, Debug, Clone, PartialEq)]
#[diesel(table_name = relations, check_for_backend(diesel::sqlite::Sqlite), treat_none_as_null = true)]
pub struct RelationRow {
    pub kind: String,
    pub from_uid: String,
    pub to_uid: String,
    pub at: i64,
    pub by: Option<String>,
}

#[derive(Queryable, Selectable, Insertable, Debug, Clone, PartialEq)]
#[diesel(table_name = requests, check_for_backend(diesel::sqlite::Sqlite))]
pub struct RequestRow {
    pub request_id: String,
    pub board: String,
    pub rev: i64,
    pub seq: i64,
}
