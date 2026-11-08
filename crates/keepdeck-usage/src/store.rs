//! The ledger on disk: the calls every session made, its recent events raw,
//! all of its history compacted into quarter-hour buckets, and the price
//! journal they are priced from.
//!
//! The store is the durable record — unlike the session index it is never
//! wiped. A schema it does not know refuses to open rather than being
//! rewritten.
//!
//! The unit of account is one provider API call, booked ONCE ([`UsageStore::book`]).
//! Money is never stored: a row is priced from the journal as it is served
//! ([`UsageStore::ledger`]).

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::catalogue::{self, CatalogueEntry, SeedHistory};
use crate::legacy_migration;
use crate::model::{CallBatch, LedgerRow, Place, Tally, TokenCounts, UsageCall, TOKEN_KINDS};
use crate::pricing::{Journal, Price, PriceRow, Rates, Tier, Usage};

/// The schema this build writes. Raised by a migration, never by a wipe.
pub const SCHEMA_VERSION: i64 = 4;

/// The width of a compacted bucket. A quarter hour divides every hour and
/// day boundary, and every real timezone offset is a multiple of it, so a
/// bucket never straddles a UTC hour, a UTC day or a local day: folding
/// buckets into any of those answers exactly what folding the events would.
pub const BUCKET_MS: f64 = 15.0 * 60.0 * 1000.0;

/// How far back the ledger serves events raw. The shortest provider window
/// is five hours, and its gauge sums usage from an arbitrary minute — raw
/// events keep that edge exact. Older history is served as buckets.
pub const RAW_WINDOW_MS: f64 = 6.0 * 60.0 * 60.0 * 1000.0;

/// How long a booked call is remembered, and so how far back a call can
/// still be booked. Three rules must agree on it, and do because they all
/// read it here: a remembered call is pruned at this age, a call older than
/// it is refused, and a followed file is read again from no earlier than it.
/// A call whose memory had been pruned yet could still be booked would be
/// booked twice. (User decision 2026-11-08: 90 days.)
pub const HORIZON_MS: f64 = 90.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// How long before the deck first saw a session its running total may have
/// begun and still count from zero: an agent the deck starts begins its
/// count a moment before the deck's binding accepts the session.
pub const FRESH_TALLY_MS: f64 = 10.0 * 60.0 * 1000.0;

/// How far before a session's newest booked call a re-read file starts — a
/// subagent's file is read on its own schedule, so its calls can land
/// slightly behind the root's.
pub const CATCH_UP_MARGIN_MS: f64 = 10.0 * 60.0 * 1000.0;

/// The ledger as the webview loads it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub rows: Vec<LedgerRow>,
    /// Whether the store holds everything the ledger ever recorded: false
    /// when an old import met lines of a newer schema and left them out.
    pub complete: bool,
    /// When the store began booking usage per model. Rows from before it
    /// counted every session as one sum, under the model its agent showed.
    pub per_model_since: Option<f64>,
}

/// The catalogue's state: the validator its last answer carried and when it
/// was last asked.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CatalogueState {
    pub etag: Option<String>,
    pub checked_at: Option<f64>,
}

pub struct UsageStore {
    conn: Connection,
    journal: Journal,
}

impl UsageStore {
    /// Open (or create) the store at `path`. `now` is when a store this
    /// build creates or migrates is migrated.
    pub fn open(path: &Path, now: f64) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::init(conn, now)
    }

    fn init(mut conn: Connection, now: f64) -> Result<Self, String> {
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
        // Each schema is reached from the one before it, a new store
        // included: there is one way to every column, and it is the
        // migration a store of an older build takes.
        if version < 1 {
            migrate_to_1(&conn)?;
        }
        if version < 2 {
            migrate_to_2(&conn, now)?;
        }
        if version < 3 {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            migrate_to_3(&tx, now)?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        if version < 4 {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            migrate_to_4(&tx, now)?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        let journal = load_journal(&conn)?;
        Ok(Self { conn, journal })
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

    /// The price journal every row is priced from.
    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    /// Make the shipped seed the journal's history up to the moment it
    /// reaches. The seed is models.dev's price history read back out of its
    /// git log, so it outranks what an older build's seed wrote — a row it
    /// corrected is replaced, one it no longer holds (a price models.dev
    /// itself fixed, a model found resold) is dropped — and what the live
    /// catalogue journaled before that moment: the same history, dated by
    /// when it was fetched rather than made, and without the corrections
    /// made since. What the catalogue journaled after it stays. Answers how
    /// many rows were added or dropped.
    pub fn adopt_seed(&mut self, seed: &SeedHistory, captured_at: f64) -> Result<usize, String> {
        let superseded: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM price WHERE source <> ?1 AND effective_from <= ?2",
                params![SEED_SOURCE, seed.until],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        // A start a later catalogue row holds is the catalogue's; the seed's
        // row for it can never be written, so it is no difference either.
        let taken: Vec<(String, f64)> = self
            .conn
            .prepare("SELECT model, effective_from FROM price WHERE source <> ?1 AND effective_from > ?2")
            .map_err(|e| e.to_string())?
            .query_map(params![SEED_SOURCE, seed.until], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let mut shipped: Vec<PriceRow> = seed
            .rows
            .iter()
            .filter(|row| !taken.iter().any(|(model, from)| *model == row.model && *from == row.from))
            .cloned()
            .collect();
        shipped.sort_by(|a, b| a.model.cmp(&b.model).then(a.from.total_cmp(&b.from)));
        let held = price_rows(&self.conn, Some(SEED_SOURCE))?;
        if held == shipped && superseded == 0 {
            return Ok(0);
        }
        let changed = held.iter().filter(|row| !shipped.contains(row)).count()
            + shipped.iter().filter(|row| !held.contains(row)).count()
            + superseded as usize;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM price WHERE source = ?1 OR effective_from <= ?2",
            params![SEED_SOURCE, seed.until],
        )
        .map_err(|e| e.to_string())?;
        for row in &shipped {
            insert_price(&tx, row, SEED_SOURCE, captured_at)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.journal = load_journal(&self.conn)?;
        Ok(changed)
    }

    /// Add price rows the journal does not hold yet — a catalogue's changes.
    /// A row the journal already holds (same model, same start) is kept as it
    /// was. Answers how many rows were added.
    pub fn merge_prices(&mut self, rows: &[PriceRow], source: &str, captured_at: f64) -> Result<usize, String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut added = 0;
        for row in rows {
            added += insert_price(&tx, row, source, captured_at)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        if added > 0 {
            self.journal = load_journal(&self.conn)?;
        }
        Ok(added)
    }

    /// The catalogue's last validator and check time.
    pub fn catalogue_state(&self) -> Result<CatalogueState, String> {
        Ok(CatalogueState {
            etag: self.meta(CATALOGUE_ETAG)?,
            checked_at: self.meta(CATALOGUE_CHECKED_AT)?.and_then(|value| value.parse().ok()),
        })
    }

    /// A catalogue was asked at `at`: journal what changed in `entries` (None
    /// when it answered "not modified"), and keep its validator.
    pub fn apply_catalogue(
        &mut self,
        entries: Option<&[CatalogueEntry]>,
        etag: Option<&str>,
        at: f64,
    ) -> Result<usize, String> {
        let rows = entries.map(|entries| catalogue::changes(&self.journal, entries, at)).unwrap_or_default();
        let added = self.merge_prices(&rows, "models.dev", at)?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        set_meta(&tx, CATALOGUE_CHECKED_AT, &at.to_string())?;
        if let Some(etag) = etag {
            set_meta(&tx, CATALOGUE_ETAG, etag)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(added)
    }

    /// Book a pane's calls, and answer the rows the booking adds to the
    /// ledger, priced.
    ///
    /// A call is booked once, whoever reports it and however often: see
    /// [`admit`] for the three rules. A booking only ever adds rows, so the
    /// rows a reader was served, plus every row booked since, always sum to
    /// the ledger the store would serve now.
    pub fn book(&mut self, batch: &CallBatch, captured_at: f64) -> Result<Vec<LedgerRow>, String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let rows = book_in(&tx, &self.journal, batch, captured_at)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// From when a followed file of `session_id` must be read again: the
    /// latest of when the deck first saw the session, a margin before its
    /// newest booked call, and the horizon. Anything older is either booked
    /// or refused already, so reading it would only be dropped.
    pub fn since(&self, agent: &str, session_id: &str, first_seen: f64, now: f64) -> Result<f64, String> {
        let stored: Option<(i64, f64)> = self
            .conn
            .query_row(
                "SELECT id, first_seen FROM session WHERE agent = ?1 AND session_id = ?2",
                params![agent, session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let first = stored.map_or(first_seen, |(_, stored_first)| stored_first);
        let mut since = (now - HORIZON_MS).max(first);
        if let Some((id, _)) = stored {
            let newest: Option<f64> = self
                .conn
                .query_row("SELECT MAX(at) FROM call WHERE session = ?1", [id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if let Some(newest) = newest {
                since = since.max(newest - CATCH_UP_MARGIN_MS);
            }
        }
        Ok(since)
    }

    /// The ledger as of `now`: buckets for history older than the raw window,
    /// events raw inside it, each priced. Raw events and remembered calls
    /// that have aged out are dropped here.
    pub fn ledger(&self, now: f64) -> Result<Ledger, String> {
        let cutoff = self.prune(now)?;
        let mut rows = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT s.agent, s.session_id, b.session, b.start, b.model, b.mode, b.tier,
                            b.tokens, b.count, b.calls, b.last_at, b.place
                       FROM bucket b JOIN session s ON s.id = b.session
                      WHERE b.start < ?1
                      ORDER BY b.last_at",
                )
                .map_err(|e| e.to_string())?;
            let buckets = stmt
                .query_map([cutoff], |r| {
                    Ok(Booked {
                        event_id: format!(
                            "bucket-{}-{}-{}-{}-{}",
                            r.get::<_, i64>(2)?,
                            r.get::<_, f64>(3)?,
                            r.get::<_, String>(4)?,
                            r.get::<_, String>(5)?,
                            r.get::<_, i64>(6)?
                        ),
                        agent: r.get(0)?,
                        session_id: r.get(1)?,
                        priced_at: r.get(3)?,
                        model: r.get(4)?,
                        mode: r.get(5)?,
                        tier: r.get::<_, i64>(6)?.max(0) as u64,
                        tokens: json_column(r, 7)?,
                        count: r.get(8)?,
                        calls: r.get(9)?,
                        // The bucket's latest instant: inside the bucket, so
                        // every fold by hour or day places it where its events were.
                        occurred_at: r.get(10)?,
                        captured_at: r.get(10)?,
                        place: json_column(r, 11)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for bucket in buckets {
                rows.push(bucket.map_err(|e| e.to_string())?.into_row(&self.journal));
            }
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.agent, s.session_id, e.event_id, e.occurred_at, e.captured_at,
                        e.model, e.mode, e.tier, e.place, e.tokens, e.calls
                   FROM event e JOIN session s ON s.id = e.session
                  WHERE e.occurred_at >= ?1
                  ORDER BY e.occurred_at",
            )
            .map_err(|e| e.to_string())?;
        let events = stmt
            .query_map([cutoff], |r| {
                Ok(Booked {
                    agent: r.get(0)?,
                    session_id: r.get(1)?,
                    event_id: r.get(2)?,
                    occurred_at: r.get(3)?,
                    priced_at: r.get(3)?,
                    captured_at: r.get(4)?,
                    model: r.get(5)?,
                    mode: r.get(6)?,
                    tier: r.get::<_, i64>(7)?.max(0) as u64,
                    place: json_column(r, 8)?,
                    tokens: json_column(r, 9)?,
                    count: 1,
                    calls: r.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for event in events {
            rows.push(event.map_err(|e| e.to_string())?.into_row(&self.journal));
        }
        Ok(Ledger {
            rows,
            complete: self.complete()?,
            per_model_since: self
                .meta(PER_MODEL_SINCE)?
                .and_then(|value| value.parse().ok()),
        })
    }

    /// Drop raw events that have aged out of the raw window — their buckets
    /// already hold them — and calls past the horizon. Answers where the raw
    /// window begins.
    fn prune(&self, now: f64) -> Result<f64, String> {
        let cutoff = raw_cutoff(now);
        self.conn
            .execute("DELETE FROM event WHERE occurred_at < ?1", [cutoff])
            .map_err(|e| e.to_string())?;
        self.conn
            .execute("DELETE FROM call WHERE at < ?1", [now - HORIZON_MS])
            .map_err(|e| e.to_string())?;
        self.conn
            .execute("DELETE FROM tally WHERE at < ?1", [now - HORIZON_MS])
            .map_err(|e| e.to_string())?;
        Ok(cutoff)
    }
}

/// The source the shipped seed's rows are journaled under.
const SEED_SOURCE: &str = "seed";

/// The meta key holding when this ledger began to keep running totals
/// (schema 4): calls booked before it were not filed by model, so no total
/// can be set against them.
const TALLIES_SINCE: &str = "tallies_since";

/// The meta key [`Ledger::per_model_since`] is kept under.
const PER_MODEL_SINCE: &str = "per_model_since";
const CATALOGUE_ETAG: &str = "catalogue.etag";
const CATALOGUE_CHECKED_AT: &str = "catalogue.checked_at";

fn set_meta(tx: &Transaction<'_>, key: &str, value: &str) -> Result<(), String> {
    tx.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The first instant served raw.
fn raw_cutoff(now: f64) -> f64 {
    ((now - RAW_WINDOW_MS) / BUCKET_MS).floor() * BUCKET_MS
}

fn bucket_start(at: f64) -> f64 {
    (at / BUCKET_MS).floor() * BUCKET_MS
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

/// A call's memory key: the agent and the call's own id, hashed to 16 bytes —
/// the agents' ids are unique within an agent, not across agents.
fn call_key(agent: &str, id: &str) -> Vec<u8> {
    let mut first: u64 = 0xcbf2_9ce4_8422_2325;
    let mut second: u64 = 0x9e37_79b9_7f4a_7c15;
    for byte in agent.bytes().chain([0]).chain(id.bytes()) {
        first = (first ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3);
        second = (second ^ u64::from(byte)).wrapping_mul(0xff51_afd7_ed55_8ccd);
        second ^= second >> 29;
    }
    [first.to_be_bytes(), second.to_be_bytes()].concat()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Whether, and how much of, `call` is new — the three rules that make a
/// call count once:
///
/// 1. A call older than the first time the deck saw its session is not
///    booked. A fork copies its source's calls into the new session with
///    their original times, so this drops every copy, for every agent —
///    including the ones whose copies carry fresh ids. It also drops what a
///    session spent before KeepDeck watched it (user decision 2026-11-08).
/// 2. A call older than [`HORIZON_MS`] is not booked: its memory may be gone.
/// 3. A call booked before books only its GROWTH, class by class. A store
///    writes one call several times as it streams (claude restates a
///    message's usage on every content block), a file is read again after a
///    restart, two processes write one session: each time, only what is new
///    counts, and a plain repeat counts nothing.
///
/// `known` is what the call was booked at so far. Answers the growth to book
/// and the counts to remember, or None when there is nothing to book.
fn admit(
    call_at: f64,
    first_seen: f64,
    now: f64,
    known: Option<&TokenCounts>,
    reported: &TokenCounts,
) -> Option<(TokenCounts, TokenCounts)> {
    if call_at <= first_seen || call_at < now - HORIZON_MS {
        return None;
    }
    let Some(known) = known else {
        return Some((reported.clone(), reported.clone()));
    };
    let mut growth = TokenCounts::default();
    let mut remembered = known.clone();
    for kind in TOKEN_KINDS {
        let was = known.get(kind).unwrap_or(0.0);
        let now_is = reported.get(kind).unwrap_or(0.0);
        if now_is > was {
            growth.set(kind, Some(now_is - was));
            remembered.set(kind, Some(now_is));
        }
    }
    (!growth.is_empty()).then_some((growth, remembered))
}

fn book_in(
    tx: &Transaction<'_>,
    journal: &Journal,
    batch: &CallBatch,
    captured_at: f64,
) -> Result<Vec<LedgerRow>, String> {
    let (session, first_seen) = upsert_session(tx, &batch.agent, &batch.session_id, batch.first_seen)?;
    let place_json = to_json(&batch.place)?;
    let mut rows = Vec::new();
    for call in &batch.calls {
        if let Some(tally) = call.tally {
            let booked = book_tally(tx, batch, session, first_seen, call, tally, captured_at)?;
            if let Some(booked) = booked {
                insert_event(tx, session, &booked, &place_json)?;
                add_to_bucket(tx, session, &booked, &place_json)?;
                rows.push(booked.into_row(journal));
            }
            continue;
        }
        let key = call_key(&batch.agent, &call.id);
        let known: Option<TokenCounts> = tx
            .query_row("SELECT tokens FROM call WHERE key = ?1", [&key], |r| r.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())?
            .map(|text| from_json(&text))
            .transpose()?;
        let reported = call.tokens.counts();
        let Some((growth, remembered)) = admit(call.at, first_seen, captured_at, known.as_ref(), &reported) else {
            continue;
        };
        let new_call = known.is_none();
        let model = call.booked_model();
        tx.execute(
            "INSERT INTO call (key, session, at, tokens, model) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens",
            params![key, session, call.at, to_json(&remembered)?, model],
        )
        .map_err(|e| e.to_string())?;
        let mode = call.mode.clone().unwrap_or_default();
        let tier = journal.tier_of(&model, call.at, reported.prompt());
        let event_id = format!("call-{}-{}", hex(&key), hex(&call_key(&batch.agent, &to_json(&remembered)?)));
        let booked = Booked {
            agent: batch.agent.clone(),
            session_id: batch.session_id.clone(),
            event_id,
            occurred_at: call.at,
            priced_at: call.at,
            captured_at,
            model,
            mode,
            tier,
            place: batch.place.clone(),
            tokens: growth,
            count: 1,
            calls: i64::from(new_call),
        };
        insert_event(tx, session, &booked, &place_json)?;
        add_to_bucket(tx, session, &booked, &place_json)?;
        rows.push(booked.into_row(journal));
    }
    Ok(rows)
}

/// What a running total adds over the session's calls (see [`Tally`]), as one
/// booking — None when it adds nothing.
///
/// A total counts everything the session spent on one model since its count
/// began: the calls the ledger booked one by one, and what no call record
/// shows. Its first sighting is its base, since the ledger cannot tell what
/// it held before the deck watched — unless the count began when the deck
/// first saw the session (a session the deck started counts from zero). A
/// fork that inherited its source's total, or a session older than the
/// deck's watch, only sets the base. From then on each larger total books
/// its growth, less what the session's calls of that model booked in
/// between, class by class and never below nothing: two processes counting
/// one session cannot book what neither spent. A total from before the deck
/// saw the session, or before this ledger kept totals at all
/// ([`TALLIES_SINCE`] — calls booked earlier were not filed by model), only
/// moves the base.
fn book_tally(
    tx: &Transaction<'_>,
    batch: &CallBatch,
    session: i64,
    first_seen: f64,
    call: &UsageCall,
    tally: Tally,
    captured_at: f64,
) -> Result<Option<Booked>, String> {
    let key = call_key(&batch.agent, &format!("tally\u{0}{}\u{0}{}", batch.session_id, call.id));
    let kept_since: f64 = tx
        .query_row("SELECT value FROM meta WHERE key = ?1", [TALLIES_SINCE], |r| r.get::<_, String>(0))
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0.0);
    let floor = first_seen.max(kept_since);
    let reported = call.tokens.counts();
    let known: Option<(f64, String)> = tx
        .query_row("SELECT at, tokens FROM tally WHERE key = ?1", [&key], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let remember = |at: f64, tokens: &TokenCounts| -> Result<(), String> {
        tx.execute(
            "INSERT INTO tally (key, session, at, tokens) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET at = excluded.at, tokens = excluded.tokens",
            params![key, session, at, to_json(tokens)?],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    };
    let fresh = tally.began >= (first_seen - FRESH_TALLY_MS).max(kept_since) && tally.began >= captured_at - HORIZON_MS;
    let (base_at, base) = match known {
        Some((at, tokens)) => (at, from_json::<TokenCounts>(&tokens)?),
        None if fresh => (tally.began, TokenCounts::default()),
        None => {
            remember(call.at, &reported)?;
            return Ok(None);
        }
    };
    let mut growth = TokenCounts::default();
    let mut remembered = base.clone();
    for kind in TOKEN_KINDS {
        let was = base.get(kind).unwrap_or(0.0);
        let now_is = reported.get(kind).unwrap_or(0.0);
        if now_is > was {
            growth.set(kind, Some(now_is - was));
            remembered.set(kind, Some(now_is));
        }
    }
    remember(base_at.max(call.at), &remembered)?;
    if growth.is_empty() || call.at <= floor || call.at < captured_at - HORIZON_MS {
        return Ok(None);
    }

    let model = call.booked_model();
    let mut booked_calls = TokenCounts::default();
    let calls: Vec<String> = tx
        .prepare("SELECT tokens FROM call WHERE session = ?1 AND model = ?2 AND at > ?3 AND at <= ?4")
        .map_err(|e| e.to_string())?
        .query_map(params![session, model, base_at, call.at], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for tokens in &calls {
        booked_calls.add(&from_json(tokens)?);
    }
    let mut left = TokenCounts::default();
    for kind in TOKEN_KINDS {
        let rest = growth.get(kind).unwrap_or(0.0) - booked_calls.get(kind).unwrap_or(0.0);
        if rest > 0.0 {
            left.set(kind, Some(rest));
        }
    }
    left.total = Some(left.billed());
    if left.billed() <= 0.0 {
        return Ok(None);
    }
    Ok(Some(Booked {
        agent: batch.agent.clone(),
        session_id: batch.session_id.clone(),
        event_id: format!("tally-{}-{}", hex(&key), hex(&call_key(&batch.agent, &to_json(&remembered)?))),
        occurred_at: call.at,
        priced_at: call.at,
        captured_at,
        model,
        mode: call.mode.clone().unwrap_or_default(),
        // A total is many requests' sum: no one prompt to cross a tier with.
        tier: 0,
        place: batch.place.clone(),
        tokens: left,
        count: 1,
        // Not a call the ledger can count: an unknown number of them.
        calls: 0,
    }))
}

/// The session's row id and the first time the ledger saw it. Set once, by
/// the first booking of the session, and never moved: a later binding's
/// claim to have seen it earlier — a pane restored with an old binding time,
/// a session from before the ledger booked calls — would let calls the
/// ledger already holds, or could not tell apart, through again.
fn upsert_session(
    tx: &Transaction<'_>,
    agent: &str,
    session_id: &str,
    first_seen: f64,
) -> Result<(i64, f64), String> {
    tx.query_row(
        "INSERT INTO session (agent, session_id, first_seen) VALUES (?1, ?2, ?3)
         ON CONFLICT(agent, session_id) DO UPDATE SET first_seen = session.first_seen
         RETURNING id, first_seen",
        params![agent, session_id, first_seen],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|e| e.to_string())
}

fn insert_event(tx: &Transaction<'_>, session: i64, booked: &Booked, place: &str) -> Result<(), String> {
    tx.execute(
        "INSERT OR IGNORE INTO event (event_id, session, occurred_at, captured_at, model, mode, tier, place, tokens, calls)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            booked.event_id,
            session,
            booked.occurred_at,
            booked.captured_at,
            booked.model,
            booked.mode,
            booked.tier as i64,
            place,
            to_json(&booked.tokens)?,
            booked.calls
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Figures added to one bucket: one booking's, or a whole bucket's carried
/// under another key.
struct BucketPart<'a> {
    session: i64,
    start: f64,
    model: &'a str,
    mode: &'a str,
    tier: u64,
    tokens: &'a TokenCounts,
    count: i64,
    calls: i64,
    first_at: f64,
    last_at: f64,
    place: &'a str,
}

/// Add one booking's figures to its bucket.
fn add_to_bucket(tx: &Transaction<'_>, session: i64, booked: &Booked, place: &str) -> Result<(), String> {
    merge_into_bucket(
        tx,
        &BucketPart {
            session,
            start: bucket_start(booked.occurred_at),
            model: &booked.model,
            mode: &booked.mode,
            tier: booked.tier,
            tokens: &booked.tokens,
            count: booked.count,
            calls: booked.calls,
            first_at: booked.occurred_at,
            last_at: booked.occurred_at,
            place,
        },
    )
}

/// Add `part` to the bucket it names: its figures summed into what the
/// bucket holds, its span widened.
fn merge_into_bucket(tx: &Transaction<'_>, part: &BucketPart<'_>) -> Result<(), String> {
    let key = params![part.session, part.start, part.model, part.mode, part.tier as i64];
    let existing: Option<(String, i64, i64, f64, f64, String)> = tx
        .query_row(
            "SELECT tokens, count, calls, first_at, last_at, place FROM bucket
              WHERE session = ?1 AND start = ?2 AND model = ?3 AND mode = ?4 AND tier = ?5",
            key,
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (mut tokens, count, calls, first_at, last_at, place) = match existing {
        Some((tokens, count, calls, first_at, last_at, place)) => {
            (from_json::<TokenCounts>(&tokens)?, count, calls, first_at, last_at, place)
        }
        None => (TokenCounts::default(), 0, 0, part.first_at, part.last_at, part.place.to_string()),
    };
    tokens.add(part.tokens);
    // The place stays the latest event's: a bucket is one session, and a
    // session that moved panes is shown where it was last.
    let place = if part.last_at >= last_at { part.place.to_string() } else { place };
    tx.execute(
        "INSERT INTO bucket (session, start, model, mode, tier, tokens, count, calls, first_at, last_at, place)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(session, start, model, mode, tier) DO UPDATE SET
             tokens = excluded.tokens, count = excluded.count, calls = excluded.calls,
             first_at = excluded.first_at, last_at = excluded.last_at, place = excluded.place",
        params![
            part.session,
            part.start,
            part.model,
            part.mode,
            part.tier as i64,
            to_json(&tokens)?,
            count + part.count,
            calls + part.calls,
            first_at.min(part.first_at),
            last_at.max(part.last_at),
            place
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// One booked figure — an event, or a bucket of a session's events — as the
/// ledger serves it. The one mapping to a ledger row, for a booking just made
/// and one read back alike; the one place a row is priced.
struct Booked {
    agent: String,
    session_id: String,
    event_id: String,
    occurred_at: f64,
    /// The instant the row is priced at: an event's own, a bucket's start.
    priced_at: f64,
    captured_at: f64,
    model: String,
    mode: String,
    tier: u64,
    place: Place,
    tokens: TokenCounts,
    count: i64,
    calls: i64,
}

impl Booked {
    fn into_row(self, journal: &Journal) -> LedgerRow {
        let priced = journal.price(Usage {
            model: &self.model,
            mode: &self.mode,
            tier: self.tier,
            at: self.priced_at,
            tokens: &self.tokens,
        });
        LedgerRow {
            event_id: self.event_id,
            occurred_at: self.occurred_at,
            captured_at: self.captured_at,
            agent: self.agent,
            model: (!self.model.is_empty()).then_some(self.model),
            model_name: priced.name,
            workspace_id: self.place.workspace_id,
            workspace_name: self.place.workspace_name,
            workspace_cwd: self.place.workspace_cwd,
            pane_id: self.place.pane_id,
            pane_name: self.place.pane_name,
            root_session_id: self.session_id.clone(),
            session_id: self.session_id,
            worktree: self.place.worktree,
            tokens: self.tokens,
            cost_usd: priced.cost_usd,
            cost_basis: priced.basis,
            count: u32::try_from(self.count).unwrap_or(u32::MAX),
            calls: u32::try_from(self.calls).unwrap_or(0),
        }
    }
}

fn insert_price(tx: &Transaction<'_>, row: &PriceRow, source: &str, captured_at: f64) -> Result<usize, String> {
    let rates = &row.price.rates;
    tx.execute(
        "INSERT OR IGNORE INTO price
             (model, effective_from, captured_at, source, name, input, output,
              cache_read, cache_write, cache_write_1h, modes, tiers)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            row.model,
            row.from,
            captured_at,
            source,
            row.name,
            rates.input,
            rates.output,
            rates.cache_read,
            rates.cache_write,
            rates.cache_write_1h,
            to_json(&row.price.modes)?,
            to_json(&row.price.tiers)?
        ],
    )
    .map_err(|e| e.to_string())
}

fn load_journal(conn: &Connection) -> Result<Journal, String> {
    Ok(Journal::new(
        price_rows(conn, None)?,
        catalogue::makers().to_vec(),
        catalogue::aliases().clone(),
    ))
}

/// The journal's rows — all of them, or those one source wrote.
fn price_rows(conn: &Connection, source: Option<&str>) -> Result<Vec<PriceRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT model, effective_from, name, input, output, cache_read, cache_write,
                    cache_write_1h, modes, tiers FROM price
              WHERE ?1 IS NULL OR source = ?1
              ORDER BY model, effective_from",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([source], |r| {
            Ok(PriceRow {
                model: r.get(0)?,
                from: r.get(1)?,
                name: r.get(2)?,
                price: Price {
                    rates: Rates {
                        input: r.get(3)?,
                        output: r.get(4)?,
                        cache_read: r.get(5)?,
                        cache_write: r.get(6)?,
                        cache_write_1h: r.get(7)?,
                    },
                    modes: json_column(r, 8)?,
                    tiers: json_column::<Vec<Tier>>(r, 9)?,
                },
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

fn migrate_to_1(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
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
         PRAGMA user_version = 1;",
    )
    .map_err(|e| e.to_string())
}

fn migrate_to_2(conn: &Connection, now: f64) -> Result<(), String> {
    // An event's provider calls. Every event an older build booked was one
    // call: it paired a call's two reported halves into one event, and
    // booked each report as a call.
    conn.execute_batch("ALTER TABLE event ADD COLUMN calls INTEGER NOT NULL DEFAULT 1;")
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)",
        params![PER_MODEL_SINCE, now.to_string()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA user_version = 2;")
        .map_err(|e| e.to_string())
}

/// Schema 3: usage booked per call and priced from a journal.
///
/// - `session` loses the cumulative observation it diffed reports against and
///   gains `first_seen` — for every old session, the moment of this
///   migration. Its usage until now is already in its old buckets, which no
///   call id can be matched against; a first sighting of NOW is what keeps a
///   pane re-reading its transcript after the upgrade from booking that
///   usage a second time as calls.
/// - `call` remembers booked calls, `price` is the journal.
/// - `bucket` and `event` are keyed by model, mode and long-context tier and
///   lose their money. Their old rows are carried over in canonical classes
///   under `<provider>/<model>` keys (see [`legacy_migration`]) — from then on they are
///   priced from the journal like every new row (user decision 2026-11-08,
///   option B). An old row that carried only a price, no tokens, has nothing
///   left to say and is dropped. Old rows know no mode and no tier.
fn migrate_to_3(tx: &Transaction<'_>, now: f64) -> Result<(), String> {
    tx.execute_batch(
        "ALTER TABLE session ADD COLUMN first_seen REAL;
         ALTER TABLE session DROP COLUMN observation;
         CREATE TABLE call (
             key BLOB PRIMARY KEY,
             session INTEGER NOT NULL REFERENCES session(id),
             at REAL NOT NULL,
             tokens TEXT NOT NULL
         ) WITHOUT ROWID;
         CREATE INDEX call_by_time ON call (at);
         CREATE INDEX call_by_session ON call (session, at);
         CREATE TABLE price (
             model TEXT NOT NULL,
             effective_from REAL NOT NULL,
             captured_at REAL NOT NULL,
             source TEXT NOT NULL,
             name TEXT,
             input REAL NOT NULL,
             output REAL NOT NULL,
             cache_read REAL,
             cache_write REAL,
             cache_write_1h REAL,
             modes TEXT NOT NULL,
             tiers TEXT NOT NULL,
             PRIMARY KEY (model, effective_from)
         ) WITHOUT ROWID;
         ALTER TABLE bucket RENAME TO bucket_v2;
         CREATE TABLE bucket (
             session INTEGER NOT NULL REFERENCES session(id),
             start REAL NOT NULL,
             model TEXT NOT NULL,
             mode TEXT NOT NULL,
             tier INTEGER NOT NULL,
             tokens TEXT NOT NULL,
             count INTEGER NOT NULL,
             calls INTEGER NOT NULL,
             first_at REAL NOT NULL,
             last_at REAL NOT NULL,
             place TEXT NOT NULL,
             PRIMARY KEY (session, start, model, mode, tier)
         );
         ALTER TABLE event RENAME TO event_v2;
         DROP INDEX event_by_time;
         DROP INDEX event_by_session;
         CREATE TABLE event (
             event_id TEXT PRIMARY KEY,
             session INTEGER NOT NULL REFERENCES session(id),
             occurred_at REAL NOT NULL,
             captured_at REAL NOT NULL,
             model TEXT NOT NULL,
             mode TEXT NOT NULL,
             tier INTEGER NOT NULL,
             place TEXT NOT NULL,
             tokens TEXT NOT NULL,
             calls INTEGER NOT NULL
         );
         CREATE INDEX event_by_time ON event (occurred_at);
         CREATE INDEX event_by_session ON event (session, occurred_at);",
    )
    .map_err(|e| e.to_string())?;
    tx.execute("UPDATE session SET first_seen = ?1", [now])
        .map_err(|e| e.to_string())?;

    // Old buckets and the old raw window are carried through the same writes
    // a booking makes, so a carried row is shaped exactly like a booked one;
    // two old spellings of one model in one quarter hour merge there.
    for old in old_rows(tx, "bucket_v2")? {
        if let Some(booked) = old.carried() {
            add_to_bucket(tx, old.session, &booked?, &old.place)?;
        }
    }
    for old in old_rows(tx, "event_v2")? {
        if let Some(booked) = old.carried() {
            insert_event(tx, old.session, &booked?, &old.place)?;
        }
    }

    tx.execute_batch(
        "DROP TABLE bucket_v2;
         DROP TABLE event_v2;
         PRAGMA user_version = 3;",
    )
    .map_err(|e| e.to_string())
}

/// Schema 4: old rows schema 3 carried under a wrong key are re-keyed.
///
/// - kimi's had its agent's name put before the provider it already named
///   (see [`legacy_migration::rekeyed`]), so one model stood under two keys,
///   the old rows' and the calls' booked since.
/// - a row booked before its agent named the model (see
///   [`legacy_migration::unnamed`]) was carried under no model, and so went
///   unpriced; it takes the model its session's next named row ran on — the
///   previous one when none follows. A session that never named a model
///   keeps it unnamed.
///
/// A re-keyed bucket merges into one already under its new key.
///
/// Schema 4 also begins the running totals ([`Tally`]): a remembered call
/// keeps the model it was booked under, so a total can be set against the
/// session's calls of its model, and `tally` remembers each total's last
/// sighting. Calls remembered before now carry no model, so totals count
/// from now on ([`TALLIES_SINCE`]).
fn migrate_to_4(tx: &Transaction<'_>, now: f64) -> Result<(), String> {
    tx.execute_batch(
        "ALTER TABLE call ADD COLUMN model TEXT;
         CREATE INDEX call_by_session_model ON call (session, model, at);
         CREATE TABLE tally (
             key BLOB PRIMARY KEY,
             session INTEGER NOT NULL REFERENCES session(id),
             at REAL NOT NULL,
             tokens TEXT NOT NULL
         ) WITHOUT ROWID;",
    )
    .map_err(|e| e.to_string())?;
    set_meta(tx, TALLIES_SINCE, &now.to_string())?;
    struct Bucket {
        session: i64,
        agent: String,
        start: f64,
        model: String,
        mode: String,
        tier: i64,
        tokens: String,
        count: i64,
        calls: i64,
        first_at: f64,
        last_at: f64,
        place: String,
    }
    let buckets: Vec<Bucket> = tx
        .prepare(
            "SELECT b.session, s.agent, b.start, b.model, b.mode, b.tier, b.tokens, b.count, b.calls,
                    b.first_at, b.last_at, b.place
               FROM bucket b JOIN session s ON s.id = b.session",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            Ok(Bucket {
                session: r.get(0)?,
                agent: r.get(1)?,
                start: r.get(2)?,
                model: r.get(3)?,
                mode: r.get(4)?,
                tier: r.get(5)?,
                tokens: r.get(6)?,
                count: r.get(7)?,
                calls: r.get(8)?,
                first_at: r.get(9)?,
                last_at: r.get(10)?,
                place: r.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    // Each session's named buckets, as re-keyed, by when they began.
    let mut named: HashMap<i64, Vec<(f64, String)>> = HashMap::new();
    for bucket in &buckets {
        if !legacy_migration::unnamed(&bucket.agent, &bucket.model) {
            let key = legacy_migration::rekeyed(&bucket.agent, &bucket.model).unwrap_or_else(|| bucket.model.clone());
            named.entry(bucket.session).or_default().push((bucket.first_at, key));
        }
    }
    for rows in named.values_mut() {
        rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    }
    let rekeyed = |agent: &str, session: i64, model: &str, at: f64, tokens: &TokenCounts, events: i64| -> Option<String> {
        if !legacy_migration::unnamed(agent, model) {
            return legacy_migration::rekeyed(agent, model);
        }
        if !legacy_migration::nameable(agent, model, tokens, events) {
            return None;
        }
        let rows = named.get(&session)?;
        rows.iter()
            .find(|(first_at, _)| *first_at >= at)
            .or_else(|| rows.last())
            .map(|(_, key)| key.clone())
    };
    for bucket in &buckets {
        let tokens: TokenCounts = from_json(&bucket.tokens)?;
        let Some(to) = rekeyed(&bucket.agent, bucket.session, &bucket.model, bucket.first_at, &tokens, bucket.count) else {
            continue;
        };
        tx.execute(
            "DELETE FROM bucket WHERE session = ?1 AND start = ?2 AND model = ?3 AND mode = ?4 AND tier = ?5",
            params![bucket.session, bucket.start, bucket.model, bucket.mode, bucket.tier],
        )
        .map_err(|e| e.to_string())?;
        merge_into_bucket(
            tx,
            &BucketPart {
                session: bucket.session,
                start: bucket.start,
                model: &to,
                mode: &bucket.mode,
                tier: bucket.tier.max(0) as u64,
                tokens: &tokens,
                count: bucket.count,
                calls: bucket.calls,
                first_at: bucket.first_at,
                last_at: bucket.last_at,
                place: &bucket.place,
            },
        )?;
    }

    struct Event {
        event_id: String,
        agent: String,
        session: i64,
        model: String,
        at: f64,
        tokens: String,
    }
    let events: Vec<Event> = tx
        .prepare(
            "SELECT e.event_id, s.agent, e.session, e.model, e.occurred_at, e.tokens
               FROM event e JOIN session s ON s.id = e.session",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |r| {
            Ok(Event {
                event_id: r.get(0)?,
                agent: r.get(1)?,
                session: r.get(2)?,
                model: r.get(3)?,
                at: r.get(4)?,
                tokens: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for Event { event_id, agent, session, model, at, tokens } in &events {
        if let Some(to) = rekeyed(agent, *session, model, *at, &from_json(tokens)?, 1) {
            tx.execute("UPDATE event SET model = ?1 WHERE event_id = ?2", params![to, event_id])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.execute_batch("PRAGMA user_version = 4;").map_err(|e| e.to_string())
}

/// A schema-2 bucket or raw event, as the schema-3 migration reads it.
struct OldRow {
    event_id: String,
    session: i64,
    agent: String,
    session_id: String,
    occurred_at: f64,
    captured_at: f64,
    model: Option<String>,
    place: String,
    tokens: String,
    count: i64,
    calls: i64,
}

impl OldRow {
    /// This row as a schema-3 booking — None when it carried no tokens (a
    /// row that only carried a price has nothing left to say).
    fn carried(&self) -> Option<Result<Booked, String>> {
        let tokens = match from_json(&self.tokens) {
            Ok(tokens) => legacy_migration::canonical_tokens(&self.agent, &tokens),
            Err(e) => return Some(Err(e)),
        };
        if tokens.billed() <= 0.0 {
            return None;
        }
        Some(from_json::<Place>(&self.place).map(|place| Booked {
            agent: self.agent.clone(),
            session_id: self.session_id.clone(),
            event_id: self.event_id.clone(),
            occurred_at: self.occurred_at,
            priced_at: self.occurred_at,
            captured_at: self.captured_at,
            model: legacy_migration::booked_model(&self.agent, self.model.as_deref().unwrap_or("")),
            mode: String::new(),
            tier: 0,
            place,
            tokens,
            count: self.count,
            calls: self.calls,
        }))
    }
}

/// Every row of a schema-2 table (`bucket_v2` or `event_v2`). A bucket is
/// read at its latest instant, which lies inside its quarter hour.
fn old_rows(tx: &Transaction<'_>, table: &str) -> Result<Vec<OldRow>, String> {
    let sql = match table {
        "bucket_v2" => {
            "SELECT 'bucket', b.session, s.agent, s.session_id, b.last_at, b.last_at, b.model,
                    b.place, b.tokens, b.count, b.calls
               FROM bucket_v2 b JOIN session s ON s.id = b.session ORDER BY b.last_at"
        }
        "event_v2" => {
            "SELECT e.event_id, e.session, s.agent, s.session_id, e.occurred_at, e.captured_at, e.model,
                    e.place, e.tokens, 1, e.calls
               FROM event_v2 e JOIN session s ON s.id = e.session ORDER BY e.occurred_at"
        }
        other => return Err(format!("no schema-2 table {other}")),
    };
    let mut stmt = tx.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(OldRow {
                event_id: r.get(0)?,
                session: r.get(1)?,
                agent: r.get(2)?,
                session_id: r.get(3)?,
                occurred_at: r.get(4)?,
                captured_at: r.get(5)?,
                model: r.get(6)?,
                place: r.get(7)?,
                tokens: r.get(8)?,
                count: r.get(9)?,
                calls: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CallTokens, UsageCall};
    use crate::pricing::CostBasis;
    use std::collections::BTreeMap;

    const DAY: f64 = 86_400_000.0;
    const NOW: f64 = 400.0 * DAY;

    fn store() -> UsageStore {
        UsageStore::init(Connection::open_in_memory().unwrap(), NOW).unwrap()
    }

    fn opus_price(from: f64) -> PriceRow {
        PriceRow {
            model: "anthropic/claude-opus-5-5".into(),
            from,
            name: Some("Claude Opus 5.5".into()),
            price: Price {
                rates: Rates { input: 4.0, output: 20.0, cache_read: Some(0.2), cache_write: Some(5.0), cache_write_1h: None },
                tiers: Vec::new(),
                modes: BTreeMap::new(),
            },
        }
    }

    fn place(pane: &str) -> Place {
        Place {
            workspace_id: "ws".into(),
            workspace_name: "Workspace".into(),
            workspace_cwd: "/w".into(),
            pane_id: pane.into(),
            pane_name: pane.into(),
            worktree: None,
        }
    }

    fn call(id: &str, at: f64, input: f64, output: f64) -> UsageCall {
        UsageCall {
            id: id.into(),
            at,
            provider: "anthropic".into(),
            model: "claude-opus-5-5".into(),
            mode: None,
            tokens: CallTokens { input, output, ..CallTokens::default() },
            tally: None,
        }
    }

    fn batch(session: &str, first_seen: f64, calls: Vec<UsageCall>) -> CallBatch {
        CallBatch {
            agent: "claude".into(),
            session_id: session.into(),
            first_seen,
            place: place("pane-1"),
            calls,
        }
    }

    fn total_cost(store: &UsageStore) -> f64 {
        store.ledger(NOW).unwrap().rows.iter().filter_map(|row| row.cost_usd).sum()
    }

    #[test]
    fn a_call_is_booked_and_priced_from_the_journal() {
        let mut s = store();
        s.merge_prices(&[opus_price(0.0)], "seed", NOW).unwrap();
        let rows = s.book(&batch("s1", NOW - DAY, vec![call("msg_1", NOW - 1000.0, 1_000_000.0, 1_000_000.0)]), NOW).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].cost_usd, Some(24.0));
        assert_eq!(rows[0].cost_basis, CostBasis::Estimated);
        assert_eq!(rows[0].model.as_deref(), Some("anthropic/claude-opus-5-5"));
        assert_eq!(rows[0].model_name.as_deref(), Some("Claude Opus 5.5"));
        assert_eq!(rows[0].calls, 1);
        assert_eq!(total_cost(&s), 24.0);
    }

    #[test]
    fn a_repeated_call_counts_once() {
        let mut s = store();
        let b = batch("s1", NOW - DAY, vec![call("msg_1", NOW - 1000.0, 100.0, 10.0)]);
        assert_eq!(s.book(&b, NOW).unwrap().len(), 1);
        assert!(s.book(&b, NOW).unwrap().is_empty(), "a plain repeat books nothing");
        let rows = s.ledger(NOW).unwrap().rows;
        assert_eq!(rows.iter().map(|r| r.calls).sum::<u32>(), 1);
        assert_eq!(rows.iter().filter_map(|r| r.tokens.input).sum::<f64>(), 100.0);
    }

    #[test]
    fn a_restated_call_books_only_its_growth() {
        let mut s = store();
        s.book(&batch("s1", NOW - DAY, vec![call("msg_1", NOW - 1000.0, 100.0, 10.0)]), NOW).unwrap();
        let rows = s.book(&batch("s1", NOW - DAY, vec![call("msg_1", NOW - 1000.0, 100.0, 50.0)]), NOW).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tokens.output, Some(40.0));
        assert_eq!(rows[0].tokens.input, None, "a class that did not grow books nothing");
        assert_eq!(rows[0].calls, 0, "growth is not another call");
        let smaller = s.book(&batch("s1", NOW - DAY, vec![call("msg_1", NOW - 1000.0, 90.0, 40.0)]), NOW).unwrap();
        assert!(smaller.is_empty(), "a smaller restatement takes nothing back");
    }

    #[test]
    fn the_same_call_in_another_session_counts_once() {
        let mut s = store();
        s.book(&batch("source", NOW - 2.0 * DAY, vec![call("msg_1", NOW - DAY, 100.0, 10.0)]), NOW).unwrap();
        let rows = s.book(&batch("other", NOW - 2.0 * DAY, vec![call("msg_1", NOW - DAY, 100.0, 10.0)]), NOW).unwrap();
        assert!(rows.is_empty(), "the call id is the agent's, not the session's");
    }

    #[test]
    fn a_call_older_than_the_sessions_first_sighting_is_not_booked() {
        let mut s = store();
        let fork_seen = NOW - DAY;
        let rows = s
            .book(&batch("fork", fork_seen, vec![call("copied", fork_seen - 1.0, 100.0, 10.0), call("same-ms", fork_seen, 1.0, 1.0), call("new", fork_seen + 1.0, 5.0, 1.0)]), NOW)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tokens.input, Some(5.0));
    }

    #[test]
    fn the_earliest_sighting_of_a_session_holds() {
        let mut s = store();
        s.book(&batch("s1", NOW - 2.0 * DAY, vec![]), NOW).unwrap();
        let rows = s.book(&batch("s1", NOW - DAY, vec![call("older", NOW - 1.5 * DAY, 7.0, 1.0)]), NOW).unwrap();
        assert_eq!(rows.len(), 1, "a later binding does not move the first sighting forward");
    }

    #[test]
    fn a_call_past_the_horizon_is_not_booked_and_is_forgotten_after_it() {
        let mut s = store();
        let old = NOW - HORIZON_MS - 1.0;
        assert!(s.book(&batch("s1", 0.0, vec![call("old", old, 1.0, 1.0)]), NOW).unwrap().is_empty());
        let recent = NOW - HORIZON_MS + DAY;
        assert_eq!(s.book(&batch("s1", 0.0, vec![call("recent", recent, 1.0, 1.0)]), NOW).unwrap().len(), 1);
        let later = NOW + 2.0 * DAY;
        s.ledger(later).unwrap();
        let remembered: i64 = s.conn.query_row("SELECT COUNT(*) FROM call", [], |r| r.get(0)).unwrap();
        assert_eq!(remembered, 0, "a call past the horizon is pruned");
        assert!(s.book(&batch("s1", 0.0, vec![call("recent", recent, 1.0, 1.0)]), later).unwrap().is_empty(), "and cannot be booked again");
    }

    #[test]
    fn since_is_the_latest_of_first_sighting_newest_call_and_horizon() {
        let mut s = store();
        assert_eq!(s.since("claude", "s1", NOW - DAY, NOW).unwrap(), NOW - DAY);
        assert_eq!(s.since("claude", "s1", 0.0, NOW).unwrap(), NOW - HORIZON_MS);
        s.book(&batch("s1", NOW - 3.0 * DAY, vec![call("c", NOW - DAY, 1.0, 1.0)]), NOW).unwrap();
        assert_eq!(s.since("claude", "s1", NOW, NOW).unwrap(), NOW - DAY - CATCH_UP_MARGIN_MS);
    }

    #[test]
    fn an_unknown_model_is_booked_and_served_unpriced() {
        let mut s = store();
        let mut c = call("k", NOW - 1000.0, 10.0, 1.0);
        c.provider = "kimi-code".into();
        c.model = "kimi-for-coding".into();
        let rows = s.book(&batch("s1", NOW - DAY, vec![c]), NOW).unwrap();
        assert_eq!(rows[0].cost_usd, None);
        assert_eq!(rows[0].cost_basis, CostBasis::Unpriced);
    }

    #[test]
    fn a_price_learned_later_reprices_the_past() {
        let mut s = store();
        s.book(&batch("s1", NOW - 2.0 * DAY, vec![call("c", NOW - DAY, 1_000_000.0, 0.0)]), NOW).unwrap();
        assert_eq!(total_cost(&s), 0.0);
        s.merge_prices(&[opus_price(NOW - 10.0 * DAY)], "models.dev", NOW).unwrap();
        assert_eq!(total_cost(&s), 4.0);
    }

    #[test]
    fn a_long_prompt_is_booked_under_the_tier_it_crossed() {
        let mut s = store();
        let mut sol = opus_price(0.0);
        sol.model = "openai/gpt-6.1-sol".into();
        sol.price.rates = Rates { input: 2.0, output: 10.0, cache_read: Some(0.1), cache_write: Some(2.5), cache_write_1h: None };
        sol.price.tiers = vec![Tier { over: 272_000, rates: Rates { input: 4.0, output: 15.0, cache_read: Some(0.2), cache_write: Some(5.0), cache_write_1h: None } }];
        s.merge_prices(&[sol], "seed", NOW).unwrap();
        let mut long = call("long", NOW - 1000.0, 100_000.0, 0.0);
        long.provider = "openai".into();
        long.model = "gpt-6.1-sol".into();
        long.tokens.cache_read = 200_000.0;
        let rows = s.book(&batch("s1", NOW - DAY, vec![long]), NOW).unwrap();
        assert!((rows[0].cost_usd.unwrap() - (0.1 * 4.0 + 0.2 * 0.2)).abs() < 1e-9, "{:?}", rows[0].cost_usd);
    }

    /// The agent's running total of the session's opus spend since `began`.
    fn total(at: f64, began: f64, input: f64, output: f64) -> UsageCall {
        UsageCall {
            id: format!("{began}:claude-opus-5-5"),
            tally: Some(Tally { began }),
            ..call("total", at, input, output)
        }
    }

    fn booked_tokens(rows: &[LedgerRow]) -> Vec<(u32, Option<f64>, Option<f64>)> {
        rows.iter().map(|row| (row.calls, row.tokens.input, row.tokens.output)).collect()
    }

    #[test]
    fn a_running_total_books_what_the_sessions_calls_left_out() {
        let mut s = store();
        s.merge_prices(&[opus_price(0.0)], "seed", NOW).unwrap();
        let seen = NOW + 1_000.0;
        let began = NOW + 500.0;
        let at = |offset: f64| seen + offset;
        let mut b = batch("s1", seen, vec![call("msg_1", at(100.0), 100.0, 10.0), total(at(200.0), began, 150.0, 30.0)]);
        let rows = s.book(&b, at(300.0)).unwrap();
        assert_eq!(
            booked_tokens(&rows),
            vec![(1, Some(100.0), Some(10.0)), (0, Some(50.0), Some(20.0))],
            "a count that began as the deck saw the session runs from zero; its rest is no call"
        );
        assert_eq!(rows[1].cost_usd, Some((50.0 * 4.0 + 20.0 * 20.0) / 1e6), "priced like any usage");

        assert!(s.book(&b, at(400.0)).unwrap().is_empty(), "the same total read again adds nothing");

        b.calls = vec![call("msg_2", at(500.0), 10.0, 0.0), total(at(600.0), began, 170.0, 30.0)];
        let rows = s.book(&b, at(700.0)).unwrap();
        assert_eq!(
            booked_tokens(&rows),
            vec![(1, Some(10.0), Some(0.0)), (0, Some(10.0), None)],
            "the next total books its growth less the calls in between"
        );
    }

    #[test]
    fn a_total_older_than_the_deck_s_watch_sets_the_base_and_books_only_what_grows() {
        let mut s = store();
        let seen = NOW + 1_000.0;
        let at = |offset: f64| seen + offset;
        // A fork inherits its source's count; a session the deck took over
        // began counting long before it.
        let began = seen - 2.0 * FRESH_TALLY_MS;
        let b = batch("s1", seen, vec![total(at(100.0), began, 1_000.0, 100.0)]);
        assert!(s.book(&b, at(200.0)).unwrap().is_empty(), "what it held before the deck saw it is not the deck's");
        let b = batch("s1", seen, vec![call("msg_1", at(300.0), 60.0, 0.0), total(at(400.0), began, 1_100.0, 90.0)]);
        let rows = s.book(&b, at(500.0)).unwrap();
        assert_eq!(booked_tokens(&rows), vec![(1, Some(60.0), Some(0.0)), (0, Some(40.0), None)]);

        let b = batch("s1", seen, vec![call("msg_2", at(600.0), 500.0, 0.0), total(at(700.0), began, 1_200.0, 90.0)]);
        let rows = s.book(&b, at(800.0)).unwrap();
        assert_eq!(booked_tokens(&rows), vec![(1, Some(500.0), Some(0.0))], "never less than nothing");

        let mut other = batch("s2", seen, vec![total(at(900.0), began, 5_000.0, 0.0)]);
        other.agent = "claude".into();
        assert!(s.book(&other, at(950.0)).unwrap().is_empty(), "another session's count of the same lineage has its own base");
    }

    #[test]
    fn a_total_from_before_the_ledger_kept_totals_only_moves_the_base() {
        let mut s = store();
        let seen = NOW - DAY;
        let began = NOW - 1_000.0;
        let b = batch("s1", seen, vec![total(NOW - 500.0, began, 400.0, 0.0)]);
        assert!(s.book(&b, NOW + 100.0).unwrap().is_empty(), "calls before schema 4 carry no model to set it against");
        let b = batch("s1", seen, vec![total(NOW + 200.0, began, 450.0, 0.0)]);
        assert_eq!(booked_tokens(&s.book(&b, NOW + 300.0).unwrap()), vec![(0, Some(50.0), None)]);
    }

    #[test]
    fn a_newer_seed_replaces_the_history_before_it_and_leaves_the_catalogues_rows_after_it() {
        let mut s = store();
        let mut wrong = opus_price(DAY);
        wrong.price.rates.cache_read = Some(0.4);
        let flap = opus_price(2.0 * DAY);
        s.adopt_seed(&SeedHistory { rows: vec![wrong, flap], until: 2.5 * DAY }, NOW).unwrap();
        // The catalogue journaled a price models.dev later fixed, then a real one.
        let mut stale = opus_price(4.0 * DAY);
        stale.price.rates.output = 99.0;
        let mut live = opus_price(6.0 * DAY);
        live.price.rates.output = 30.0;
        s.merge_prices(&[stale, live.clone()], "models.dev", NOW).unwrap();

        let corrected = opus_price(DAY);
        let mut moved = opus_price(3.5 * DAY);
        moved.price.rates.output = 25.0;
        let newer = SeedHistory { rows: vec![moved.clone(), corrected.clone()], until: 5.0 * DAY };
        assert_eq!(
            s.adopt_seed(&newer, NOW).unwrap(),
            5,
            "two old seed rows and the catalogue's row before the seed's end dropped, two rows written"
        );
        let rows = price_rows(&s.conn, None).unwrap();
        assert_eq!(rows, vec![corrected, moved, live], "the seed's history up to its end, the catalogue's after it");
        assert_eq!(s.journal().latest("anthropic/claude-opus-5-5").unwrap().price.rates.output, 30.0, "the journal reads the new rows");
        assert_eq!(s.adopt_seed(&newer, NOW).unwrap(), 0, "the same seed again changes nothing");
    }

    #[test]
    fn merging_the_same_prices_twice_adds_nothing() {
        let mut s = store();
        assert_eq!(s.merge_prices(&[opus_price(0.0)], "seed", NOW).unwrap(), 1);
        assert_eq!(s.merge_prices(&[opus_price(0.0)], "seed", NOW).unwrap(), 0);
    }

    #[test]
    fn a_catalogue_answer_is_journaled_and_its_validator_kept() {
        let mut s = store();
        let entry = CatalogueEntry {
            model: "anthropic/claude-opus-5-5".into(),
            name: Some("Claude Opus 5.5".into()),
            price: opus_price(0.0).price,
        };
        assert_eq!(s.apply_catalogue(Some(std::slice::from_ref(&entry)), Some("W/\"1\""), NOW).unwrap(), 1);
        assert_eq!(s.apply_catalogue(Some(&[entry]), Some("W/\"2\""), NOW + DAY).unwrap(), 0);
        assert_eq!(s.apply_catalogue(None, None, NOW + 2.0 * DAY).unwrap(), 0);
        let state = s.catalogue_state().unwrap();
        assert_eq!(state.etag.as_deref(), Some("W/\"2\""));
        assert_eq!(state.checked_at, Some(NOW + 2.0 * DAY));
    }

    #[test]
    fn a_schema_2_store_is_carried_into_schema_3_in_canonical_classes() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to_1(&conn).unwrap();
        migrate_to_2(&conn, 1.0).unwrap();
        let place_json = to_json(&place("pane-1")).unwrap();
        conn.execute_batch(
            "INSERT INTO session (id, agent, session_id, observation) VALUES
                 (1, 'claude', 'c1', '{}'), (2, 'codex', 'x1', '{}'), (3, 'claude', 'c2', '{}');",
        )
        .unwrap();
        let bucket = |session: i64, start: f64, model: &str, tokens: &str, pico: i64| {
            conn.execute(
                "INSERT INTO bucket (session, start, model, tokens, cost_pico, cost_events, count, calls, first_at, last_at, place)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, 1, ?2, ?2, ?6)",
                params![session, start, model, tokens, pico, place_json],
            )
            .unwrap();
        };
        bucket(1, DAY, "Opus 5.5 (1M context)", r#"{"input":10,"output":20,"cacheRead":300,"cacheWrite":40}"#, 5_000_000_000_000);
        bucket(1, DAY, "claude-opus-5-5", r#"{"input":1,"output":2}"#, 0);
        bucket(1, 2.0 * DAY, "", r#"{}"#, 7_000_000_000_000);
        bucket(2, DAY, "gpt-6.1-sol xhigh", r#"{"input":1000,"output":10,"cacheRead":900,"reasoning":4}"#, 0);
        conn.execute(
            "INSERT INTO event (event_id, session, occurred_at, captured_at, model, place, tokens, cost_usd, calls)
             VALUES ('usage-1', 3, ?1, ?1, 'Sonnet 5.5', ?2, '{\"input\":5,\"output\":6}', 0.5, 1)",
            params![NOW - 1000.0, place_json],
        )
        .unwrap();
        conn.execute_batch("PRAGMA user_version = 2;").unwrap();

        let tx = conn.transaction().unwrap();
        migrate_to_3(&tx, NOW).unwrap();
        tx.commit().unwrap();
        let s = UsageStore::init(conn, NOW).unwrap();

        let first_seen: f64 = s.conn.query_row("SELECT first_seen FROM session WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(first_seen, NOW, "an old session is first seen by the call ledger at the migration");
        let rows = s.ledger(NOW).unwrap().rows;
        let opus: Vec<_> = rows.iter().filter(|r| r.model.as_deref() == Some("anthropic/claude-opus-5-5")).collect();
        assert_eq!(opus.len(), 1, "two spellings of one model in one bucket merge");
        assert_eq!(opus[0].tokens.input, Some(11.0));
        assert_eq!(opus[0].tokens.total, Some(373.0));
        assert_eq!(opus[0].count, 2);
        assert!(rows.iter().all(|r| r.model.as_deref() != Some("anthropic/")), "a price-only row is dropped");
        let codex = rows.iter().find(|r| r.agent == "codex").unwrap();
        assert_eq!(codex.model.as_deref(), Some("openai/gpt-6.1-sol"));
        assert_eq!(codex.tokens.input, Some(100.0), "codex input loses its cached prefix");
        let sonnet = rows.iter().find(|r| r.event_id == "usage-1").unwrap();
        assert_eq!(sonnet.model.as_deref(), Some("anthropic/claude-sonnet-5-5"));
        assert!(rows.iter().all(|r| r.cost_basis == CostBasis::Unpriced), "no money survives the migration; the journal prices");

        let mut s = s;
        let mut reread = UsageCall {
            id: "msg_already_in_old_buckets".into(),
            at: NOW - 1000.0,
            provider: "anthropic".into(),
            model: "claude-opus-5-5".into(),
            mode: None,
            tokens: CallTokens { input: 10.0, ..CallTokens::default() },
            tally: None,
        };
        let b = CallBatch { agent: "claude".into(), session_id: "c1".into(), first_seen: 0.0, place: place("pane-1"), calls: vec![reread.clone()] };
        assert!(s.book(&b, NOW + 1000.0).unwrap().is_empty(), "a transcript re-read after the upgrade does not book the old buckets' usage again");
        reread.id = "msg_after_upgrade".into();
        reread.at = NOW + 500.0;
        let b = CallBatch { calls: vec![reread], ..b };
        assert_eq!(s.book(&b, NOW + 1000.0).unwrap().len(), 1);
    }

    /// A store as a schema-3 build left it.
    fn schema_3() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to_1(&conn).unwrap();
        migrate_to_2(&conn, 1.0).unwrap();
        let tx = conn.transaction().unwrap();
        migrate_to_3(&tx, 1.0).unwrap();
        tx.commit().unwrap();
        conn
    }

    #[test]
    fn a_schema_3_store_rekeys_old_rows_under_the_key_their_model_is_booked_under() {
        struct Old {
            conn: Connection,
        }
        let s = Old { conn: schema_3() };
        s.conn
            .execute_batch(
                "INSERT INTO session (id, agent, session_id, first_seen) VALUES
                     (1, 'kimi', 'k1', 0), (2, 'opencode', 'o1', 0), (3, 'claude', 'c1', 0), (4, 'claude', 'c2', 0);",
            )
            .unwrap();
        let bucket_at = |session: i64, start: f64, model: &str, tokens: &str, first: f64, last: f64, pane: &str| {
            s.conn
                .execute(
                    "INSERT INTO bucket (session, start, model, mode, tier, tokens, count, calls, first_at, last_at, place)
                     VALUES (?1, ?2, ?3, '', 0, ?4, 1, 1, ?5, ?6, ?7)",
                    params![session, start, model, tokens, first, last, to_json(&place(pane)).unwrap()],
                )
                .unwrap();
        };
        let bucket = |session: i64, model: &str, tokens: &str, first: f64, last: f64, pane: &str| {
            bucket_at(session, DAY, model, tokens, first, last, pane);
        };
        bucket(1, "kimi/kimi-code/k3", r#"{"input":10,"output":1}"#, DAY + 10.0, DAY + 20.0, "pane-old");
        bucket(1, "kimi-code/k3", r#"{"input":5,"cacheRead":7}"#, DAY + 5.0, DAY + 30.0, "pane-new");
        bucket(1, "kimi/kimi-code/kimi-for-coding", r#"{"input":4}"#, DAY + 1.0, DAY + 2.0, "pane-old");
        bucket(2, "opencode/glm-5.3", r#"{"input":3}"#, DAY, DAY, "pane-1");
        // claude's first reports, before it named its model, then the model.
        bucket(3, "anthropic/", r#"{"cacheRead":100}"#, DAY + 1.0, DAY + 2.0, "pane-1");
        bucket(3, "anthropic/claude-fable-5-1", r#"{"cacheRead":50}"#, DAY + 3.0, DAY + 4.0, "pane-1");
        bucket_at(3, 2.0 * DAY, "anthropic/claude-opus-5-5", r#"{"cacheRead":20}"#, 2.0 * DAY, 2.0 * DAY, "pane-1");
        bucket_at(3, 3.0 * DAY, "anthropic/", r#"{"cacheRead":9}"#, 3.0 * DAY, 3.0 * DAY, "pane-1");
        // A counter's first sighting, booked as one figure: no call.
        bucket_at(3, 0.5 * DAY, "anthropic/", r#"{"cacheRead":5000000}"#, 0.5 * DAY, 0.5 * DAY, "pane-1");
        bucket(4, "anthropic/", r#"{"cacheRead":1}"#, DAY, DAY, "pane-2");
        s.conn
            .execute(
                "INSERT INTO event (event_id, session, occurred_at, captured_at, model, mode, tier, place, tokens, calls)
                 VALUES ('e1', 1, ?1, ?1, 'kimi/kimi-code/kimi-for-coding', '', 0, ?2, '{\"input\":2}', 1)",
                params![NOW - 1000.0, to_json(&place("pane-old")).unwrap()],
            )
            .unwrap();
        let s = UsageStore::init(s.conn, NOW).unwrap();
        let version: i64 = s.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let models: Vec<(i64, f64, String, String)> = s
            .conn
            .prepare("SELECT session, start, model, tokens FROM bucket ORDER BY session, start, model")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let models: Vec<(i64, f64, &str, Option<f64>)> = models
            .iter()
            .map(|(session, start, model, tokens)| {
                (*session, *start / DAY, model.as_str(), from_json::<TokenCounts>(tokens).unwrap().cache_read)
            })
            .collect();
        assert_eq!(
            &models[..3],
            &[(1, 1.0, "kimi-code/k3", Some(7.0)), (1, 1.0, "kimi-code/kimi-for-coding", None), (2, 1.0, "opencode/glm-5.3", None)],
            "one key per kimi model; another agent's key stands"
        );
        assert_eq!(
            &models[3..],
            &[
                (3, 0.5, "anthropic/", Some(5_000_000.0)),
                (3, 1.0, "anthropic/claude-fable-5-1", Some(150.0)),
                (3, 2.0, "anthropic/claude-opus-5-5", Some(20.0)),
                (3, 3.0, "anthropic/claude-opus-5-5", Some(9.0)),
                (4, 1.0, "anthropic/", Some(1.0)),
            ],
            "an unnamed row takes its session's next named model, the last one after it, none in a session that named \
             none, and a lump bigger than any call stays unnamed"
        );
        let (tokens, counts, span, place): (String, (i64, i64), (f64, f64), String) = s
            .conn
            .query_row(
                "SELECT tokens, count, calls, first_at, last_at, place FROM bucket WHERE model = 'kimi-code/k3'",
                [],
                |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?), (r.get(3)?, r.get(4)?), r.get(5)?)),
            )
            .unwrap();
        let tokens: TokenCounts = from_json(&tokens).unwrap();
        assert_eq!((tokens.input, tokens.output, tokens.cache_read), (Some(15.0), Some(1.0), Some(7.0)));
        assert_eq!(counts, (2, 2), "the merged bucket counts both rows' events and calls");
        assert_eq!(span, (DAY + 5.0, DAY + 30.0), "its span covers both");
        assert_eq!(from_json::<Place>(&place).unwrap().pane_id, "pane-new", "it stays where the session was last");
        let event: String = s.conn.query_row("SELECT model FROM event WHERE event_id = 'e1'", [], |r| r.get(0)).unwrap();
        assert_eq!(event, "kimi-code/kimi-for-coding");
    }
}
