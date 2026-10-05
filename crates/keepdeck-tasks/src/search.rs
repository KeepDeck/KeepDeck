//! Full-text search over the tasks (title and brief) and their comments.
//!
//! The ONE place the store speaks SQL by hand: an FTS5 table is a virtual
//! table Diesel's DSL does not describe (it is filtered out of
//! `schema.rs`). Every statement binds its values; nothing is spliced in.
//! Covered by its own tests, since the compiler does not check these.

use diesel::prelude::*;
use diesel::sql_types::{BigInt, Nullable, Text};

use crate::error::Result;
use crate::model::SearchHit;

/// The task's own document — its title and brief as they are now.
pub fn index_task(conn: &mut SqliteConnection, uid: &str, title: &str, body: &str) -> Result<()> {
    diesel::sql_query("DELETE FROM search WHERE uid = ? AND n IS NULL").bind::<Text, _>(uid).execute(conn)?;
    diesel::sql_query("INSERT INTO search(uid, n, text) VALUES (?, NULL, ?)")
        .bind::<Text, _>(uid)
        .bind::<Text, _>(format!("{title}\n{body}"))
        .execute(conn)?;
    Ok(())
}

/// A comment, once — comments are never edited.
pub fn index_comment(conn: &mut SqliteConnection, uid: &str, n: i64, body: &str) -> Result<()> {
    diesel::sql_query("INSERT INTO search(uid, n, text) VALUES (?, ?, ?)")
        .bind::<Text, _>(uid)
        .bind::<BigInt, _>(n)
        .bind::<Text, _>(body)
        .execute(conn)?;
    Ok(())
}

pub fn forget_task(conn: &mut SqliteConnection, uid: &str) -> Result<()> {
    diesel::sql_query("DELETE FROM search WHERE uid = ?").bind::<Text, _>(uid).execute(conn)?;
    Ok(())
}

pub fn forget_all(conn: &mut SqliteConnection) -> Result<()> {
    diesel::sql_query("DELETE FROM search").execute(conn)?;
    Ok(())
}

#[derive(QueryableByName)]
struct Hit {
    #[diesel(sql_type = Text)]
    uid: String,
    #[diesel(sql_type = Text)]
    board: String,
    #[diesel(sql_type = Nullable<BigInt>)]
    n: Option<i64>,
    #[diesel(sql_type = Text)]
    snippet: String,
}

/// Tasks and comments matching `query`, best first; `boards` narrows to
/// those boards (empty: all).
pub fn search(conn: &mut SqliteConnection, query: &str, boards: &[String], limit: i64) -> Result<Vec<SearchHit>> {
    let fts = fts_query(query);
    if fts.is_empty() || limit <= 0 {
        return Ok(Vec::new());
    }
    // Ranked by FTS5, then narrowed to the boards asked for: the narrowing
    // is a join, so it costs nothing extra.
    let placeholders = vec!["?"; boards.len()].join(", ");
    let narrow = if boards.is_empty() { String::new() } else { format!("AND t.board IN ({placeholders})") };
    let sql = format!(
        "SELECT s.uid AS uid, t.board AS board, s.n AS n, snippet(search, 2, '[', ']', '…', 12) AS snippet
         FROM search s JOIN tasks t ON t.uid = s.uid
         WHERE search MATCH ? {narrow}
         ORDER BY rank LIMIT ?"
    );
    let mut q = diesel::sql_query(sql).into_boxed::<diesel::sqlite::Sqlite>().bind::<Text, _>(fts);
    for board in boards {
        q = q.bind::<Text, _>(board.clone());
    }
    let hits: Vec<Hit> = q.bind::<BigInt, _>(limit).load(conn)?;
    Ok(hits.into_iter().map(|h| SearchHit { uid: h.uid, board: h.board, comment: h.n, snippet: h.snippet }).collect())
}

/// A person's words as an FTS5 query: each word a quoted term (so `-`, `:`
/// and quotes in it are text, not syntax), all of them required, the last
/// one a prefix so a word being typed already matches.
pub fn fts_query(query: &str) -> String {
    let words: Vec<String> = query.split_whitespace().map(|word| word.replace('"', "\"\"")).collect();
    let last = words.len().saturating_sub(1);
    words
        .iter()
        .enumerate()
        .map(|(i, word)| if i == last { format!("\"{word}\"*") } else { format!("\"{word}\"") })
        .collect::<Vec<_>>()
        .join(" ")
}
