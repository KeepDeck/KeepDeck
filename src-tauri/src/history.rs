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

impl From<KeyedAnswer> for KeyedAnswerDto {
    /// The ONE place an answer's key meets its variant — production's
    /// only path, and the guard's too: the Foreign branch carries the
    /// ASKED agent, never the found owner (the wrong-attribution
    /// signature; substituting the owner stays a valid DTO and a green
    /// wire — only this mapping, pinned through this same impl, catches
    /// it).
    fn from(KeyedAnswer { agent, session_id, kind }: KeyedAnswer) -> Self {
        match kind {
            LookupKind::Hit { reference, title, mtime } => {
                KeyedAnswerDto::Hit { agent, session_id, reference, title, mtime }
            }
            LookupKind::Foreign { agents } => {
                KeyedAnswerDto::Foreign { agent, session_id, agents }
            }
            LookupKind::Absent => KeyedAnswerDto::Absent { agent, session_id },
        }
    }
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
            .map(|answers| answers.into_iter().map(KeyedAnswerDto::from).collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use keepdeck_index::{KeyedAnswer, LookupKind};

    /// The wire contract AND the mapping, pinned in one place: every case
    /// builds a KeyedAnswer (the crate's own answer) and crosses the
    /// production boundary — KeyedAnswerDto::from, the command's only
    /// path — before serde serializes. No DTO is constructed directly:
    /// the test cannot bypass the seam it guards. What is pinned: the
    /// EXACT JSON per branch, and — for Foreign — that the ASKED agent
    /// rides in the key while the found owner does NOT (substituting the
    /// owner is a valid DTO with a green wire; only this mapping knows).
    #[test]
    fn keyed_answer_wire_json_is_exact_per_branch() {
        let hit = KeyedAnswerDto::from(KeyedAnswer {
            agent: "claude".into(),
            session_id: "a".into(),
            kind: LookupKind::Hit {
                reference: "/cl/p/-repo/a.jsonl".into(),
                title: Some("named by the index".into()),
                mtime: 1_787_090_317_140,
            },
        });
        assert_eq!(
            serde_json::to_string(&hit).unwrap(),
            r#"{"status":"hit","agent":"claude","sessionId":"a","reference":"/cl/p/-repo/a.jsonl","title":"named by the index","mtime":1787090317140}"#,
        );
        // A hit with no title: present-and-none, not absent — the field
        // is on the wire as null while reference/mtime stay live.
        let untitled = KeyedAnswerDto::from(KeyedAnswer {
            agent: "claude".into(),
            session_id: "untitled".into(),
            kind: LookupKind::Hit {
                reference: "/cl/p/-repo/u.jsonl".into(),
                title: None,
                mtime: 5,
            },
        });
        assert_eq!(
            serde_json::to_string(&untitled).unwrap(),
            r#"{"status":"hit","agent":"claude","sessionId":"untitled","reference":"/cl/p/-repo/u.jsonl","title":null,"mtime":5}"#,
        );
        // Foreign: the id exists — under a DIFFERENT agent than asked.
        // The key carries the asked pair; the found owner rides only in
        // `agents`. The negative assertion is the anchor: a future
        // "optimization" that substitutes the owner into the key fails
        // here even if the exact JSON is weakened.
        let foreign = KeyedAnswerDto::from(KeyedAnswer {
            agent: "claude".into(),
            session_id: "kimi-9".into(),
            kind: LookupKind::Foreign { agents: vec!["kimi".into()] },
        });
        assert_eq!(
            serde_json::to_string(&foreign).unwrap(),
            r#"{"status":"foreign","agent":"claude","sessionId":"kimi-9","agents":["kimi"]}"#,
        );
        let KeyedAnswerDto::Foreign { agent, agents, .. } = &foreign else {
            panic!("expected the foreign variant");
        };
        assert_ne!(
            agent, &agents[0],
            "the found owner must NOT ride in the key — the asked agent does",
        );
        // Absent: the key and nothing else — no null fields leaking.
        let absent = KeyedAnswerDto::from(KeyedAnswer {
            agent: "claude".into(),
            session_id: "nope".into(),
            kind: LookupKind::Absent,
        });
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
