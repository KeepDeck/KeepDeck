//! Adapter over `keepdeck-index` ([F8] global session browser): the search
//! index lives at `<keepdeck_home>/index.sqlite` and is a DISPOSABLE
//! projection — see the crate docs. Discovery/parsing happens in the agent
//! plugins (webview side); these commands only move normalized rows in and
//! search hits out, so the hot search path never touches a plugin.

use std::sync::Mutex;

use keepdeck_index::{IndexRow, IndexedRef, SearchHit, SessionIndex};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Default)]
pub struct HistoryIndex(Mutex<Option<SessionIndex>>);

fn with_index<T>(
    state: &State<'_, HistoryIndex>,
    f: impl FnOnce(&mut SessionIndex) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "index lock poisoned")?;
    if guard.is_none() {
        let home = crate::paths::keepdeck_home().ok_or("no home directory")?;
        *guard = Some(SessionIndex::open(&home.join("index.sqlite"))?);
    }
    f(guard.as_mut().expect("just opened"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedRefDto {
    pub reference: String,
    pub mtime: i64,
    pub size: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRowDto {
    pub session_id: String,
    pub reference: String,
    pub cwd: String,
    pub title: Option<String>,
    #[serde(default)]
    pub transcript_path: Option<String>,
    pub mtime: i64,
    pub size: i64,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitDto {
    pub agent: String,
    pub session_id: String,
    pub reference: String,
    pub cwd: String,
    pub title: Option<String>,
    pub transcript_path: Option<String>,
    pub mtime: i64,
    pub snippet: Option<String>,
}

/// The stored refs of one agent — the incremental scan's diff base.
#[tauri::command(async)]
pub fn index_refs(
    state: State<'_, HistoryIndex>,
    agent: String,
) -> Result<Vec<IndexedRefDto>, String> {
    with_index(&state, |index| {
        Ok(index
            .refs(&agent)?
            .into_iter()
            .map(|IndexedRef { reference, mtime, size }| IndexedRefDto {
                reference,
                mtime,
                size,
            })
            .collect())
    })
}

/// Upsert freshly scanned sessions (normalized by the agent's plugin).
#[tauri::command(async)]
pub fn index_upsert(
    state: State<'_, HistoryIndex>,
    agent: String,
    rows: Vec<IndexRowDto>,
) -> Result<(), String> {
    with_index(&state, |index| {
        let rows: Vec<IndexRow> = rows
            .into_iter()
            .map(|r| IndexRow {
                agent: agent.clone(),
                session_id: r.session_id,
                reference: r.reference,
                cwd: r.cwd,
                title: r.title,
                transcript_path: r.transcript_path,
                mtime: r.mtime,
                size: r.size,
                content: r.content,
            })
            .collect();
        index.upsert(&rows)
    })
}

/// Drop an agent's sessions that vanished from its store.
#[tauri::command(async)]
pub fn index_prune(
    state: State<'_, HistoryIndex>,
    agent: String,
    live: Vec<String>,
) -> Result<usize, String> {
    with_index(&state, |index| index.prune(&agent, &live))
}

/// One page of hits plus the full match count — fetched together, under one
/// lock hold, so "shown X of N" never mixes two index states.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPageDto {
    pub hits: Vec<SearchHitDto>,
    pub total: i64,
}

/// Search the index (empty query = newest sessions), one page at a time.
/// `agent` narrows to one CLI's sessions (the spawn-dialog picker).
#[tauri::command(async)]
pub fn index_search(
    state: State<'_, HistoryIndex>,
    query: String,
    limit: usize,
    offset: usize,
    agent: Option<String>,
) -> Result<SearchPageDto, String> {
    with_index(&state, |index| {
        let agent = agent.as_deref();
        let total = index.search_total(&query, agent)?;
        let hits = index
            .search(&query, limit, offset, agent)?
            .into_iter()
            .map(
                |SearchHit {
                     agent,
                     session_id,
                     reference,
                     cwd,
                     title,
                     transcript_path,
                     mtime,
                     snippet,
                 }| SearchHitDto {
                    agent,
                    session_id,
                    reference,
                    cwd,
                    title,
                    transcript_path,
                    mtime,
                    snippet,
                },
            )
            .collect();
        Ok(SearchPageDto { hits, total })
    })
}
