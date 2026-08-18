//! Adapter over `keepdeck-index` ([F8] global session browser): the search
//! index lives at `<keepdeck_home>/index.sqlite` and is a DISPOSABLE
//! projection — see the crate docs. Discovery/parsing happens in the agent
//! plugins (webview side); these commands only move normalized rows in and
//! search hits out, so the hot search path never touches a plugin.

use std::sync::Mutex;

use keepdeck_index::{
    FolderScope, IndexRow, IndexedRef, KeyedAnswer, LookupKind, SearchHit,
    SessionIndex,
};
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

/// A session the prune DROPPED — the (agent, session_id) key whose cached
/// answers are stale from this moment.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrunedKeyDto {
    pub agent: String,
    pub session_id: String,
}

/// Drop an agent's sessions that vanished from its store; returns the
/// dropped keys so per-key caches can devalue exactly those.
#[tauri::command(async)]
pub fn index_prune(
    state: State<'_, HistoryIndex>,
    agent: String,
    live: Vec<String>,
) -> Result<Vec<PrunedKeyDto>, String> {
    with_index(&state, |index| {
        index.prune(&agent, &live).map(|dropped| {
            dropped
                .into_iter()
                .map(|(agent, session_id)| PrunedKeyDto { agent, session_id })
                .collect()
        })
    })
}

/// One (agent, session_id) join key — the journal row's targeted ask.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupKeyDto {
    pub agent: String,
    pub session_id: String,
}

/// One keyed lookup answer on the wire: the question it answers rides
/// WITH it, so belonging never depends on order or count. The key is the
/// ASKED pair (in the Foreign branch, deliberately not the agent that
/// was found — that is the branch's whole point). A tagged enum — the
/// key as each variant's own fields, no flatten (serde's tag/flatten do
/// not compose; they never need to here). `rename_all` renames the
/// VARIANTS; `rename_all_fields` the fields — without the latter the
/// wire would silently carry `session_id` instead of `sessionId`.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum KeyedAnswerDto {
    Hit {
        agent: String,
        session_id: String,
        reference: String,
        title: Option<String>,
        mtime: i64,
    },
    Foreign {
        agent: String,
        session_id: String,
        agents: Vec<String>,
    },
    Absent {
        agent: String,
        session_id: String,
    },
}

/// Answer (agent, session_id) keys exactly — the journal join's targeted
/// ask; every answer carries its own key. Duplicate keys are a contract
/// violation and refuse loudly.
#[tauri::command(async)]
pub fn index_lookup(
    state: State<'_, HistoryIndex>,
    keys: Vec<LookupKeyDto>,
) -> Result<Vec<KeyedAnswerDto>, String> {
    with_index(&state, |index| {
        let keys: Vec<(String, String)> = keys
            .into_iter()
            .map(|k| (k.agent, k.session_id))
            .collect();
        index
            .lookup(&keys)
            .map(|answers| {
                answers
                    .into_iter()
                    .map(|KeyedAnswer { agent, session_id, kind }| match kind {
                        LookupKind::Hit { reference, title, mtime } => {
                            KeyedAnswerDto::Hit { agent, session_id, reference, title, mtime }
                        }
                        LookupKind::Foreign { agents } => {
                            KeyedAnswerDto::Foreign { agent, session_id, agents }
                        }
                        LookupKind::Absent => KeyedAnswerDto::Absent { agent, session_id },
                    })
                    .collect()
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire contract, pinned EXACTLY: what serde actually serializes
    /// for each branch — the TS union is written against these strings.
    /// `title: null` on a hit is deliberate (a title is present-and-none,
    /// not absent); foreign and absent carry the KEY and nothing else —
    /// no null fields leaking through.
    #[test]
    fn keyed_answer_wire_json_is_exact_per_branch() {
        let hit = KeyedAnswerDto::Hit {
            agent: "claude".into(),
            session_id: "a".into(),
            reference: "/cl/p/-repo/a.jsonl".into(),
            title: Some("named by the index".into()),
            mtime: 1_787_090_317_140,
        };
        assert_eq!(
            serde_json::to_string(&hit).unwrap(),
            r#"{"status":"hit","agent":"claude","sessionId":"a","reference":"/cl/p/-repo/a.jsonl","title":"named by the index","mtime":1787090317140}"#,
        );
        let untitled = KeyedAnswerDto::Hit {
            agent: "claude".into(),
            session_id: "untitled".into(),
            reference: "/cl/p/-repo/u.jsonl".into(),
            title: None,
            mtime: 5,
        };
        assert_eq!(
            serde_json::to_string(&untitled).unwrap(),
            r#"{"status":"hit","agent":"claude","sessionId":"untitled","reference":"/cl/p/-repo/u.jsonl","title":null,"mtime":5}"#,
        );
        let foreign = KeyedAnswerDto::Foreign {
            agent: "claude".into(),
            session_id: "kimi-9".into(),
            agents: vec!["kimi".into()],
        };
        assert_eq!(
            serde_json::to_string(&foreign).unwrap(),
            r#"{"status":"foreign","agent":"claude","sessionId":"kimi-9","agents":["kimi"]}"#,
        );
        let absent = KeyedAnswerDto::Absent {
            agent: "claude".into(),
            session_id: "nope".into(),
        };
        assert_eq!(
            serde_json::to_string(&absent).unwrap(),
            r#"{"status":"absent","agent":"claude","sessionId":"nope"}"#,
        );
    }
}

/// One page of hits plus the full match count — fetched together, under one
/// lock hold, so "shown X of N" never mixes two index states.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPageDto {
    pub hits: Vec<SearchHitDto>,
    pub total: i64,
}

/// Directory membership carried IN a search: the workspace block asks
/// `only`, the global block `except`. Exact cwd paths both ways.
#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum FolderScopeDto {
    Only { dirs: Vec<String> },
    Except { dirs: Vec<String> },
}

impl From<FolderScopeDto> for FolderScope {
    fn from(dto: FolderScopeDto) -> Self {
        match dto {
            FolderScopeDto::Only { dirs } => FolderScope::Only(dirs),
            FolderScopeDto::Except { dirs } => FolderScope::Except(dirs),
        }
    }
}

/// Search the index (empty query = newest sessions), one page at a time.
/// `agent` narrows to one CLI's sessions (the spawn-dialog picker);
/// `folders` splits the store by directory membership so each sessions
/// block pages over its own set, fetching nothing it will throw away.
#[tauri::command(async)]
pub fn index_search(
    state: State<'_, HistoryIndex>,
    query: String,
    limit: usize,
    offset: usize,
    agent: Option<String>,
    folders: Option<FolderScopeDto>,
) -> Result<SearchPageDto, String> {
    with_index(&state, |index| {
        let agent = agent.as_deref();
        let scope = folders.map(FolderScope::from);
        let scope_ref = scope.as_ref();
        let total = index.search_total(&query, agent, scope_ref)?;
        let hits = index
            .search(&query, limit, offset, agent, scope_ref)?
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
