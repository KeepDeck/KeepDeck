//! The ledger on disk: what every session last reported, its recent events
//! raw, and all of its history compacted into quarter-hour buckets.
//!
//! The store is the durable record — unlike the session index it is never
//! wiped. A schema it does not know refuses to open rather than being
//! rewritten.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::delta::{usage_delta, Delta, DeltaCost};
use crate::event_id::event_id;
use crate::model::{
    CaptureContext, CostSource, LedgerRow, Observation, SessionOrigin, TokenCounts, UsageReport,
    Worktree, TOKEN_KINDS,
};

/// The schema this build writes. Raised by a migration, never by a wipe.
pub const SCHEMA_VERSION: i64 = 1;

/// The width of a compacted bucket. A quarter hour divides every hour and
/// day boundary, and every real timezone offset is a multiple of it, so a
/// bucket never straddles a UTC hour, a UTC day or a local day: folding
/// buckets into any of those answers exactly what folding the events would.
pub const BUCKET_MS: f64 = 15.0 * 60.0 * 1000.0;

/// How far back the ledger serves events raw. The shortest provider window
/// is five hours, and its gauge sums usage from an arbitrary minute — raw
/// events keep that edge exact. Older history is served as buckets.
pub const RAW_WINDOW_MS: f64 = 6.0 * 60.0 * 60.0 * 1000.0;

/// How close a priced-only report and a counted-only report of the same
/// session must be to be one provider call. Claude reports a call's cost
/// (statusline) and its tokens (transcript) separately, about 1.5 s apart at
/// the median; as two events every call was booked twice.
pub const PAIR_WINDOW_MS: f64 = 3_000.0;

/// An observation instant must be positive and can never postdate its
/// capture; anything else is the capture instant.
pub fn clamp_occurred_at(occurred_at: f64, captured_at: f64) -> f64 {
    if occurred_at.is_nan() || occurred_at <= 0.0 || occurred_at > captured_at {
        captured_at
    } else {
        occurred_at
    }
}

/// The key a session's base is kept under.
pub fn session_key(agent: &str, session_id: &str) -> String {
    format!("{agent}\0{session_id}")
}

/// Whether a session's first report is a base rather than usage.
fn seeds_baseline(origin: SessionOrigin, complete: bool) -> bool {
    match origin {
        SessionOrigin::Inherited => true,
        SessionOrigin::Fresh => false,
        SessionOrigin::Unknown => !complete,
    }
}

/// The ledger as the webview loads it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub rows: Vec<LedgerRow>,
    /// Whether the store holds everything the ledger ever recorded: false
    /// when an import met lines of a newer schema and left them out.
    pub complete: bool,
}

pub struct UsageStore {
    conn: Connection,
}

/// One event's figures, as they are added into a bucket.
struct Contribution<'a> {
    tokens: &'a TokenCounts,
    cost_usd: Option<f64>,
    count: i64,
    calls: i64,
    occurred_at: f64,
}

impl UsageStore {
    /// Open (or create) the store at `path`.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "the usage store has schema {version}, newer than this build's {SCHEMA_VERSION}"
            ));
        }
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(|e| e.to_string())?;
        if version == 0 {
            conn.execute_batch(&format!(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE session (
                     id INTEGER PRIMARY KEY,
                     agent TEXT NOT NULL,
                     session_id TEXT NOT NULL,
                     observation TEXT NOT NULL,
                     UNIQUE (agent, session_id)
                 );
                 CREATE TABLE event (
                     event_id TEXT PRIMARY KEY,
                     session INTEGER NOT NULL REFERENCES session(id),
                     occurred_at REAL NOT NULL,
                     captured_at REAL NOT NULL,
                     model TEXT,
                     place TEXT NOT NULL,
                     tokens TEXT NOT NULL,
                     cost_usd REAL
                 );
                 CREATE INDEX event_by_time ON event (occurred_at);
                 CREATE INDEX event_by_session ON event (session, occurred_at);
                 CREATE TABLE bucket (
                     session INTEGER NOT NULL REFERENCES session(id),
                     start REAL NOT NULL,
                     model TEXT NOT NULL,
                     tokens TEXT NOT NULL,
                     cost_pico INTEGER NOT NULL,
                     cost_events INTEGER NOT NULL,
                     count INTEGER NOT NULL,
                     calls INTEGER NOT NULL,
                     first_at REAL NOT NULL,
                     last_at REAL NOT NULL,
                     place TEXT NOT NULL,
                     PRIMARY KEY (session, start, model)
                 );
                 PRAGMA user_version = {SCHEMA_VERSION};"
            ))
            .map_err(|e| e.to_string())?;
        }
        Ok(Self { conn })
    }

    /// Whether every line ever recorded is in the store.
    pub fn complete(&self) -> Result<bool, String> {
        Ok(self.meta("withheld")?.is_none_or(|n| n == "0"))
    }

    fn meta(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())
    }

    /// Book one cumulative report from a pane, and answer the row the
    /// booking adds to the ledger — `None` when there was nothing to book
    /// (no movement, a duplicate, or a base being set).
    ///
    /// A report that completes a call reported in halves adds a row with no
    /// count and no calls: the call is already in the ledger as its first
    /// half, and the row brings only what that half lacked. So the rows a
    /// reader was served, plus every row booked since, always sum to the
    /// ledger the store would serve now — a reader only ever appends, and
    /// never rewrites a row it has already folded.
    pub fn record(
        &mut self,
        report: &UsageReport,
        context: &CaptureContext,
        captured_at: f64,
    ) -> Result<Option<LedgerRow>, String> {
        let complete = self.complete()?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let row = record_in(&tx, report, context, captured_at, complete)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(row)
    }

    /// The ledger as of `now`: buckets for history older than the raw window,
    /// events raw inside it. Raw events that have aged out are dropped here —
    /// their buckets already hold them.
    pub fn ledger(&self, now: f64) -> Result<Ledger, String> {
        let cutoff = self.prune(now)?;
        let mut rows = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT s.agent, s.session_id, b.session, b.start, b.model, b.tokens,
                            b.cost_pico, b.cost_events, b.count, b.calls, b.last_at, b.place
                       FROM bucket b JOIN session s ON s.id = b.session
                      WHERE b.start < ?1
                      ORDER BY b.last_at",
                )
                .map_err(|e| e.to_string())?;
            let buckets = stmt
                .query_map([cutoff], |r| {
                    Ok(BucketRow {
                        agent: r.get(0)?,
                        session_id: r.get(1)?,
                        session: r.get(2)?,
                        start: r.get(3)?,
                        model: r.get(4)?,
                        tokens: r.get(5)?,
                        cost_pico: r.get(6)?,
                        cost_events: r.get(7)?,
                        count: r.get(8)?,
                        calls: r.get(9)?,
                        last_at: r.get(10)?,
                        place: r.get(11)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for bucket in buckets {
                rows.push(bucket.map_err(|e| e.to_string())?.into_row()?);
            }
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.agent, s.session_id, e.event_id, e.occurred_at, e.captured_at,
                        e.model, e.place, e.tokens, e.cost_usd
                   FROM event e JOIN session s ON s.id = e.session
                  WHERE e.occurred_at >= ?1
                  ORDER BY e.occurred_at",
            )
            .map_err(|e| e.to_string())?;
        let events = stmt
            .query_map([cutoff], |r| {
                Ok(RecordedEvent {
                    agent: r.get(0)?,
                    session_id: r.get(1)?,
                    event_id: r.get(2)?,
                    occurred_at: r.get(3)?,
                    captured_at: r.get(4)?,
                    model: r.get(5)?,
                    place: json_column(r, 6)?,
                    tokens: json_column(r, 7)?,
                    cost_usd: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for event in events {
            rows.push(event.map_err(|e| e.to_string())?.into_row());
        }
        Ok(Ledger {
            rows,
            complete: self.complete()?,
        })
    }

    /// Drop raw events that have aged out of the raw window — their buckets
    /// already hold them. One bucket's width of raw history is kept past the
    /// window, so a call's second half can still find its first. Answers
    /// where the raw window begins.
    fn prune(&self, now: f64) -> Result<f64, String> {
        let cutoff = raw_cutoff(now);
        self.conn
            .execute(
                "DELETE FROM event WHERE occurred_at < ?1",
                [cutoff - BUCKET_MS],
            )
            .map_err(|e| e.to_string())?;
        Ok(cutoff)
    }

    /// Prune, then give the freed pages back to the file system — after an
    /// import that wrote half a million raw rows only to fold them.
    pub(crate) fn compact(&self, now: f64) -> Result<(), String> {
        self.prune(now)?;
        self.conn
            .execute_batch("VACUUM;")
            .map_err(|e| e.to_string())
    }

    /// Record that `withheld` lines of a newer schema were left out of an
    /// import (they stay in the imported file), and that `source` was taken.
    pub(crate) fn mark_imported_in(
        tx: &Transaction<'_>,
        source: &str,
        withheld: u64,
    ) -> Result<(), String> {
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('imported_from', ?1), ('withheld', ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![source, withheld.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn imported(&self) -> Result<bool, String> {
        Ok(self.meta("imported_from")?.is_some())
    }

    pub(crate) fn transaction(&mut self) -> Result<Transaction<'_>, String> {
        self.conn.transaction().map_err(|e| e.to_string())
    }

    /// Give a session's base every dimension it does not have yet, from
    /// `before`, without booking anything — the import's way of starting each
    /// counter where the old ledger had it when that counter first appeared.
    pub(crate) fn seed_missing_in(
        tx: &Transaction<'_>,
        agent: &str,
        session_id: &str,
        before: &Observation,
    ) -> Result<(), String> {
        let mut base = session_base(tx, agent, session_id)?.unwrap_or_default();
        let mut changed = false;
        for kind in TOKEN_KINDS {
            if base.tokens.get(kind).is_none() {
                if let Some(value) = before.tokens.get(kind) {
                    base.tokens.set(kind, Some(value));
                    changed = true;
                }
            }
        }
        if base.cost_usd.is_none() && before.cost_usd.is_some() {
            base.cost_usd = before.cost_usd;
            changed = true;
        }
        if changed {
            upsert_session(tx, agent, session_id, &base)?;
        }
        Ok(())
    }
}

/// The first instant served raw.
fn raw_cutoff(now: f64) -> f64 {
    ((now - RAW_WINDOW_MS) / BUCKET_MS).floor() * BUCKET_MS
}

/// The facts about where an event happened, kept as one JSON value: they are
/// read back whole, never queried.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Place {
    workspace_id: String,
    workspace_name: String,
    workspace_cwd: String,
    pane_id: String,
    pane_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree: Option<Worktree>,
}

impl Place {
    fn of(context: &CaptureContext) -> Self {
        Place {
            workspace_id: context.workspace_id.clone(),
            workspace_name: context.workspace_name.clone(),
            workspace_cwd: context.workspace_cwd.clone(),
            pane_id: context.pane_id.clone(),
            pane_name: context.pane_name.clone(),
            worktree: context.worktree.clone(),
        }
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

fn from_json<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

/// A JSON text column, decoded where the row is read.
fn json_column<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row,
    index: usize,
) -> rusqlite::Result<T> {
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn upsert_session(
    tx: &Transaction<'_>,
    agent: &str,
    session_id: &str,
    observation: &Observation,
) -> Result<i64, String> {
    tx.query_row(
        "INSERT INTO session (agent, session_id, observation) VALUES (?1, ?2, ?3)
         ON CONFLICT(agent, session_id) DO UPDATE SET observation = excluded.observation
         RETURNING id",
        params![agent, session_id, to_json(observation)?],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn session_base(
    tx: &Transaction<'_>,
    agent: &str,
    session_id: &str,
) -> Result<Option<Observation>, String> {
    let text: Option<String> = tx
        .query_row(
            "SELECT observation FROM session WHERE agent = ?1 AND session_id = ?2",
            params![agent, session_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    text.map(|text| from_json(&text)).transpose()
}

/// The session's latest event, when it is still held raw.
struct LastEvent {
    event_id: String,
    occurred_at: f64,
    model: Option<String>,
    tokens: TokenCounts,
    cost_usd: Option<f64>,
}

fn last_event(tx: &Transaction<'_>, session: i64) -> Result<Option<LastEvent>, String> {
    let row = tx
        .query_row(
            "SELECT event_id, occurred_at, model, tokens, cost_usd FROM event
              WHERE session = ?1 ORDER BY occurred_at DESC, rowid DESC LIMIT 1",
            [session],
            |r| {
                let last = LastEvent {
                    event_id: r.get(0)?,
                    occurred_at: r.get(1)?,
                    model: r.get(2)?,
                    tokens: TokenCounts::default(),
                    cost_usd: r.get(4)?,
                };
                Ok((last, r.get::<_, String>(3)?))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    row.map(|(mut last, tokens)| {
        last.tokens = from_json(&tokens)?;
        Ok(last)
    })
    .transpose()
}

fn delta_cost(delta: &Delta) -> Option<f64> {
    match delta.cost {
        DeltaCost::Provider(usd) => Some(usd),
        DeltaCost::Unavailable => None,
    }
}

/// Whether `delta` is the other half of `last`: one of them only priced,
/// the other only counted.
fn completes(last: &LastEvent, delta: &Delta, occurred_at: f64) -> bool {
    let priced_only = |tokens: &TokenCounts, cost: Option<f64>| tokens.is_empty() && cost.is_some();
    let counted_only =
        |tokens: &TokenCounts, cost: Option<f64>| !tokens.is_empty() && cost.is_none();
    let cost = delta_cost(delta);
    (occurred_at - last.occurred_at).abs() <= PAIR_WINDOW_MS
        && ((priced_only(&last.tokens, last.cost_usd) && counted_only(&delta.tokens, cost))
            || (counted_only(&last.tokens, last.cost_usd) && priced_only(&delta.tokens, cost)))
}

pub(crate) fn record_in(
    tx: &Transaction<'_>,
    report: &UsageReport,
    context: &CaptureContext,
    captured_at: f64,
    complete: bool,
) -> Result<Option<LedgerRow>, String> {
    let agent = report.agent.as_str();
    let session_id = context.session_id.as_str();
    let previous = session_base(tx, agent, session_id)?;
    let delta = usage_delta(
        report.total_tokens.as_ref(),
        report.cost_usd,
        previous.as_ref(),
        seeds_baseline(context.origin, complete),
    );
    let session = upsert_session(tx, agent, session_id, &delta.observation)?;
    if delta.is_empty() {
        return Ok(None);
    }
    let id = event_id(
        &session_key(agent, session_id),
        previous.as_ref(),
        &delta.observation,
        report.sequence.unwrap_or(report.reported_at),
    );
    let known: bool = tx
        .query_row("SELECT 1 FROM event WHERE event_id = ?1", [&id], |_| Ok(()))
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if known {
        return Ok(None);
    }
    let occurred_at = clamp_occurred_at(report.reported_at, captured_at);
    let place = Place::of(context);
    let place_json = to_json(&place)?;
    let cost = delta_cost(&delta);

    if let Some(last) = last_event(tx, session)?.filter(|last| completes(last, &delta, occurred_at))
    {
        // One call, reported in halves: the last event becomes the whole call.
        let mut tokens = last.tokens.clone();
        tokens.add(&delta.tokens);
        let cost_usd = last.cost_usd.or(cost);
        let model = last.model.clone().or_else(|| report.model.clone());
        tx.execute(
            "UPDATE event SET tokens = ?2, cost_usd = ?3, model = ?4, place = ?5 WHERE event_id = ?1",
            params![last.event_id, to_json(&tokens)?, cost_usd, model, place_json],
        )
        .map_err(|e| e.to_string())?;
        // Move the call's figures to the bucket of its whole: out of the
        // first half's model bucket, in under the call's model.
        let first_half = Contribution {
            tokens: &last.tokens,
            cost_usd: last.cost_usd,
            count: 1,
            calls: 1,
            occurred_at: last.occurred_at,
        };
        add_to_bucket(
            tx,
            session,
            last.model.as_deref(),
            &first_half,
            -1,
            &place_json,
        )?;
        let whole = Contribution {
            tokens: &tokens,
            cost_usd,
            count: 1,
            calls: 1,
            occurred_at: last.occurred_at,
        };
        add_to_bucket(tx, session, model.as_deref(), &whole, 1, &place_json)?;
        // This half, placed in its call: same instant, the call's model.
        let mut row = RecordedEvent {
            agent: agent.to_string(),
            session_id: session_id.to_string(),
            event_id: id,
            occurred_at: last.occurred_at,
            captured_at,
            model,
            place,
            tokens: delta.tokens,
            cost_usd: cost,
        }
        .into_row();
        row.count = 0;
        row.calls = 0;
        return Ok(Some(row));
    }

    tx.execute(
        "INSERT INTO event (event_id, session, occurred_at, captured_at, model, place, tokens, cost_usd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            session,
            occurred_at,
            captured_at,
            report.model,
            place_json,
            to_json(&delta.tokens)?,
            cost
        ],
    )
    .map_err(|e| e.to_string())?;
    let contribution = Contribution {
        tokens: &delta.tokens,
        cost_usd: cost,
        count: 1,
        calls: 1,
        occurred_at,
    };
    add_to_bucket(
        tx,
        session,
        report.model.as_deref(),
        &contribution,
        1,
        &place_json,
    )?;
    let row = RecordedEvent {
        agent: agent.to_string(),
        session_id: session_id.to_string(),
        event_id: id,
        occurred_at,
        captured_at,
        model: report.model.clone(),
        place,
        tokens: delta.tokens,
        cost_usd: cost,
    };
    Ok(Some(row.into_row()))
}

fn to_pico(usd: f64) -> i64 {
    (usd * 1e12).round() as i64
}

fn scaled(tokens: &TokenCounts, sign: i64) -> TokenCounts {
    let mut out = TokenCounts::default();
    for kind in TOKEN_KINDS {
        out.set(kind, tokens.get(kind).map(|v| v * sign as f64));
    }
    out
}

/// A bucket's running figures beside its token sums.
struct BucketFigures {
    pico: i64,
    cost_events: i64,
    count: i64,
    calls: i64,
    first_at: f64,
    last_at: f64,
}

/// Add (`sign` 1) or take back (`sign` -1) one event's figures in its bucket.
fn add_to_bucket(
    tx: &Transaction<'_>,
    session: i64,
    model: Option<&str>,
    contribution: &Contribution<'_>,
    sign: i64,
    place: &str,
) -> Result<(), String> {
    let start = (contribution.occurred_at / BUCKET_MS).floor() * BUCKET_MS;
    let model = model.unwrap_or("");
    let existing: Option<(String, BucketFigures)> = tx
        .query_row(
            "SELECT tokens, cost_pico, cost_events, count, calls, first_at, last_at FROM bucket
              WHERE session = ?1 AND start = ?2 AND model = ?3",
            params![session, start, model],
            |r| {
                Ok((
                    r.get(0)?,
                    BucketFigures {
                        pico: r.get(1)?,
                        cost_events: r.get(2)?,
                        count: r.get(3)?,
                        calls: r.get(4)?,
                        first_at: r.get(5)?,
                        last_at: r.get(6)?,
                    },
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (mut tokens, figures) = match existing {
        Some((tokens, figures)) => (from_json::<TokenCounts>(&tokens)?, figures),
        None => (
            TokenCounts::default(),
            BucketFigures {
                pico: 0,
                cost_events: 0,
                count: 0,
                calls: 0,
                first_at: contribution.occurred_at,
                last_at: contribution.occurred_at,
            },
        ),
    };
    let BucketFigures {
        mut pico,
        mut cost_events,
        mut count,
        mut calls,
        mut first_at,
        mut last_at,
    } = figures;
    tokens.add(&scaled(contribution.tokens, sign));
    if let Some(usd) = contribution.cost_usd {
        pico += sign * to_pico(usd);
        cost_events += sign;
    }
    count += sign * contribution.count;
    calls += sign * contribution.calls;
    if count <= 0 {
        tx.execute(
            "DELETE FROM bucket WHERE session = ?1 AND start = ?2 AND model = ?3",
            params![session, start, model],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    if sign > 0 {
        first_at = first_at.min(contribution.occurred_at);
        last_at = last_at.max(contribution.occurred_at);
    }
    // A kind that added up to nothing is absent, as it would be on an event.
    for kind in TOKEN_KINDS {
        if tokens.get(kind) == Some(0.0) {
            tokens.set(kind, None);
        }
    }
    tx.execute(
        "INSERT INTO bucket (session, start, model, tokens, cost_pico, cost_events, count, calls, first_at, last_at, place)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(session, start, model) DO UPDATE SET
             tokens = excluded.tokens, cost_pico = excluded.cost_pico,
             cost_events = excluded.cost_events, count = excluded.count, calls = excluded.calls,
             first_at = excluded.first_at, last_at = excluded.last_at,
             place = CASE WHEN ?12 THEN excluded.place ELSE bucket.place END",
        params![
            session,
            start,
            model,
            to_json(&tokens)?,
            pico,
            cost_events,
            count,
            calls,
            first_at,
            last_at,
            place,
            sign > 0 && contribution.occurred_at >= last_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

struct BucketRow {
    agent: String,
    session_id: String,
    session: i64,
    start: f64,
    model: String,
    tokens: String,
    cost_pico: i64,
    cost_events: i64,
    count: i64,
    calls: i64,
    last_at: f64,
    place: String,
}

impl BucketRow {
    fn into_row(self) -> Result<LedgerRow, String> {
        let place: Place = from_json(&self.place)?;
        let cost_usd = (self.cost_events > 0).then(|| self.cost_pico as f64 / 1e12);
        Ok(LedgerRow {
            event_id: format!("bucket-{}-{}-{}", self.session, self.start, self.model),
            // The bucket's latest instant: inside the bucket, so every fold by
            // hour or day places it where its events were.
            occurred_at: self.last_at,
            captured_at: self.last_at,
            agent: self.agent,
            model: (!self.model.is_empty()).then_some(self.model),
            workspace_id: place.workspace_id,
            workspace_name: place.workspace_name,
            workspace_cwd: place.workspace_cwd,
            pane_id: place.pane_id,
            pane_name: place.pane_name,
            root_session_id: self.session_id.clone(),
            session_id: self.session_id,
            worktree: place.worktree,
            tokens: from_json(&self.tokens)?,
            cost_source: CostSource::of(cost_usd),
            cost_usd,
            count: u32::try_from(self.count).unwrap_or(u32::MAX),
            calls: u32::try_from(self.calls).unwrap_or(u32::MAX),
            cost_events: u32::try_from(self.cost_events).unwrap_or(u32::MAX),
        })
    }
}

/// One recorded event: its facts and the place it was captured in. The one
/// mapping from an event to the row the ledger serves, for an event just
/// booked and one read back alike.
struct RecordedEvent {
    agent: String,
    session_id: String,
    event_id: String,
    occurred_at: f64,
    captured_at: f64,
    model: Option<String>,
    place: Place,
    tokens: TokenCounts,
    cost_usd: Option<f64>,
}

impl RecordedEvent {
    fn into_row(self) -> LedgerRow {
        LedgerRow {
            event_id: self.event_id,
            occurred_at: self.occurred_at,
            captured_at: self.captured_at,
            agent: self.agent,
            model: self.model,
            workspace_id: self.place.workspace_id,
            workspace_name: self.place.workspace_name,
            workspace_cwd: self.place.workspace_cwd,
            pane_id: self.place.pane_id,
            pane_name: self.place.pane_name,
            root_session_id: self.session_id.clone(),
            session_id: self.session_id,
            worktree: self.place.worktree,
            tokens: self.tokens,
            cost_source: CostSource::of(self.cost_usd),
            cost_usd: self.cost_usd,
            count: 1,
            calls: 1,
            cost_events: u32::from(self.cost_usd.is_some()),
        }
    }
}
