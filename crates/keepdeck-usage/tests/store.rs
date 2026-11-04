use std::collections::BTreeMap;

use keepdeck_usage::model::{
    CaptureContext, CostSource, ModelCounters, SessionOrigin, TokenCounts, UsageReport, Worktree,
};
use keepdeck_usage::store::{BUCKET_MS, RAW_WINDOW_MS};
use keepdeck_usage::{import_jsonl, LedgerRow, UsageStore};

const HOUR: f64 = 3_600_000.0;
/// A quarter-hour boundary, so tests can place events inside one bucket.
const NOW: f64 = 1_790_000_100_000.0 - (1_790_000_100_000.0 % BUCKET_MS);

fn store() -> (tempfile::TempDir, UsageStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = UsageStore::open(&dir.path().join("usage.sqlite"), NOW).unwrap();
    (dir, store)
}

fn context(origin: SessionOrigin) -> CaptureContext {
    CaptureContext {
        workspace_id: "ws-1".into(),
        workspace_name: "Deck".into(),
        workspace_cwd: "/repo".into(),
        pane_id: "pane-1".into(),
        pane_name: "agent".into(),
        session_id: "s-1".into(),
        origin,
        worktree: None,
    }
}

fn input(value: f64) -> TokenCounts {
    TokenCounts {
        input: Some(value),
        ..TokenCounts::default()
    }
}

fn report(tokens: Option<f64>, cost: Option<f64>, at: f64) -> UsageReport {
    UsageReport {
        agent: "claude".into(),
        model: Some("Opus".into()),
        total_tokens: tokens.map(input),
        cost_usd: cost,
        by_model: None,
        reported_at: at,
        sequence: None,
    }
}

/// A claude-shaped report: the session's running cost under the model the
/// pane runs on, and each model's input and messages so far.
fn per_model(model: &str, cost: Option<f64>, models: &[(&str, f64, f64)], at: f64) -> UsageReport {
    let by_model: BTreeMap<String, ModelCounters> = models
        .iter()
        .map(|(model, tokens, calls)| {
            let counters = ModelCounters {
                total_tokens: input(*tokens),
                calls: Some(*calls),
            };
            (model.to_string(), counters)
        })
        .collect();
    UsageReport {
        agent: "claude".into(),
        model: Some(model.into()),
        total_tokens: Some(input(models.iter().map(|(_, tokens, _)| tokens).sum())),
        cost_usd: cost,
        by_model: Some(by_model),
        reported_at: at,
        sequence: None,
    }
}

fn booked(rows: Vec<LedgerRow>) -> LedgerRow {
    assert_eq!(rows.len(), 1, "the report books one row");
    rows.into_iter().next().unwrap()
}

/// Input tokens, cost and calls per model, over some rows.
fn by_model(rows: &[LedgerRow]) -> BTreeMap<String, (f64, f64, u32)> {
    let mut out = BTreeMap::new();
    for row in rows {
        let entry = out
            .entry(row.model.clone().unwrap_or_default())
            .or_insert((0.0, 0.0, 0));
        entry.0 += row.tokens.input.unwrap_or(0.0);
        entry.1 += row.cost_usd.unwrap_or(0.0);
        entry.2 += row.calls;
    }
    out
}

/// Input tokens, cost, events, calls and priced events over some rows.
fn totals(rows: &[LedgerRow]) -> (f64, f64, u32, u32, u32) {
    rows.iter().fold((0.0, 0.0, 0, 0, 0), |sum, row| {
        (
            sum.0 + row.tokens.input.unwrap_or(0.0),
            sum.1 + row.cost_usd.unwrap_or(0.0),
            sum.2 + row.count,
            sum.3 + row.calls,
            sum.4 + row.cost_events,
        )
    })
}

#[test]
fn a_fresh_session_books_its_first_report_and_every_delta_after() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    let first = booked(
        store
            .record(&report(Some(100.0), Some(1.0), NOW), &fresh, NOW)
            .unwrap(),
    );
    assert_eq!(first.tokens, input(100.0));
    assert_eq!(first.cost_usd, Some(1.0));
    let second = booked(
        store
            .record(
                &report(Some(150.0), Some(1.5), NOW + 60_000.0),
                &fresh,
                NOW + 60_000.0,
            )
            .unwrap(),
    );
    assert_eq!(second.tokens, input(50.0));
    assert_eq!(second.cost_usd, Some(0.5));
}

#[test]
fn a_recent_event_is_served_back_as_it_was_booked() {
    let (_dir, mut store) = store();
    let in_worktree = CaptureContext {
        worktree: Some(Worktree {
            path: "/repo/.worktrees/fix".into(),
            branch: Some("fix".into()),
            repo: "/repo".into(),
        }),
        ..context(SessionOrigin::Fresh)
    };
    let booked = booked(
        store
            .record(
                &report(Some(100.0), Some(1.0), NOW),
                &in_worktree,
                NOW + 5.0,
            )
            .unwrap(),
    );
    assert_eq!(booked.pane_name, "agent");
    assert_eq!(booked.worktree, in_worktree.worktree);
    // Read back from disk: the same row, the place it was captured in included.
    let ledger = store.ledger(NOW + 60_000.0).unwrap();
    assert_eq!(ledger.rows, vec![booked]);
}

#[test]
fn a_repeated_report_books_nothing() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    store
        .record(&report(Some(100.0), None, NOW), &fresh, NOW)
        .unwrap();
    assert!(store
        .record(&report(Some(100.0), None, NOW + 1.0), &fresh, NOW + 1.0)
        .unwrap()
        .is_empty());
}

#[test]
fn a_resumed_session_seeds_its_base_and_books_only_what_follows() {
    let (_dir, mut store) = store();
    let resumed = context(SessionOrigin::Inherited);
    assert!(store
        .record(&report(Some(10_000.0), None, NOW), &resumed, NOW)
        .unwrap()
        .is_empty());
    let next = booked(
        store
            .record(
                &report(Some(10_040.0), None, NOW + 1.0),
                &resumed,
                NOW + 1.0,
            )
            .unwrap(),
    );
    assert_eq!(next.tokens, input(40.0));
}

#[test]
fn a_price_and_a_count_are_each_their_own_event_and_only_the_count_is_a_call() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    store
        .record(&report(Some(100.0), Some(1.0), NOW), &fresh, NOW)
        .unwrap();
    let priced = booked(
        store
            .record(
                &report(Some(100.0), Some(1.25), NOW + 5_000.0),
                &fresh,
                NOW + 5_000.0,
            )
            .unwrap(),
    );
    assert!(priced.tokens.is_empty());
    assert_eq!(priced.cost_usd, Some(0.25));
    assert_eq!((priced.count, priced.calls, priced.cost_events), (1, 0, 1));
    let counted = booked(
        store
            .record(
                &report(Some(180.0), Some(1.25), NOW + 6_600.0),
                &fresh,
                NOW + 6_600.0,
            )
            .unwrap(),
    );
    assert_eq!(counted.tokens, input(80.0));
    assert_eq!(
        (counted.count, counted.calls, counted.cost_events),
        (1, 1, 0)
    );
    let ledger = store.ledger(NOW + 10_000.0).unwrap().rows;
    assert_eq!(
        ledger[1..],
        [priced, counted],
        "served back as they were booked"
    );
}

#[test]
fn what_was_served_plus_what_was_booked_since_sums_to_the_ledger() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    store
        .record(&report(Some(100.0), Some(1.0), NOW), &fresh, NOW)
        .unwrap();
    let served = store.ledger(NOW + 1.0).unwrap().rows;
    let mut held = served.clone();
    for (tokens, cost, at) in [
        (100.0, 1.25, 5_000.0),
        (180.0, 1.25, 6_600.0),
        (260.0, 1.25, 20_000.0),
        (260.0, 1.75, 21_000.0),
    ] {
        held.extend(
            store
                .record(
                    &report(Some(tokens), Some(cost), NOW + at),
                    &fresh,
                    NOW + at,
                )
                .unwrap(),
        );
    }
    let now = store.ledger(NOW + 30_000.0).unwrap().rows;
    assert_eq!(totals(&held), totals(&now));
    assert_eq!(totals(&now), (260.0, 1.75, 5, 3, 3));
}

#[test]
fn one_messages_price_and_count_book_one_call_in_two_rows() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    // The statusline prices the call before the transcript has counted it…
    let priced = booked(
        store
            .record(
                &UsageReport {
                    total_tokens: None,
                    by_model: None,
                    ..per_model("claude-opus-5-5", Some(0.25), &[], NOW)
                },
                &fresh,
                NOW,
            )
            .unwrap(),
    );
    // …and the transcript counts it 1.6 s later, the price unchanged.
    let counted = booked(
        store
            .record(
                &per_model(
                    "claude-opus-5-5",
                    Some(0.25),
                    &[("claude-opus-5-5", 100.0, 1.0)],
                    NOW + 1_600.0,
                ),
                &fresh,
                NOW + 1_600.0,
            )
            .unwrap(),
    );
    assert_eq!((priced.cost_usd, priced.calls), (Some(0.25), 0));
    assert_eq!((counted.cost_usd, counted.calls), (None, 1));
    assert_eq!(counted.tokens, input(100.0));
    assert_eq!(counted.model.as_deref(), Some("claude-opus-5-5"));
}

#[test]
fn two_messages_between_reports_are_two_calls() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    let row = booked(
        store
            .record(
                &per_model("opus", None, &[("opus", 300.0, 2.0)], NOW),
                &fresh,
                NOW,
            )
            .unwrap(),
    );
    assert_eq!(row.calls, 2);
}

#[test]
fn a_subagent_on_another_model_is_booked_under_its_own() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    let rows = store
        .record(
            &per_model(
                "opus",
                Some(0.5),
                &[("opus", 100.0, 1.0), ("haiku", 40.0, 3.0)],
                NOW,
            ),
            &fresh,
            NOW,
        )
        .unwrap();
    assert_eq!(
        by_model(&rows),
        BTreeMap::from([
            ("haiku".to_string(), (40.0, 0.0, 3)),
            ("opus".to_string(), (100.0, 0.5, 1)),
        ]),
        "the price goes under the pane's model, as the provider names no other"
    );
    assert_eq!(rows.len(), 3, "a row per model, and one for the price");
}

#[test]
fn a_switch_of_model_books_only_what_the_session_spent_since() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    let mut held = store
        .record(
            &per_model("opus", Some(1.0), &[("opus", 100.0, 1.0)], NOW),
            &fresh,
            NOW,
        )
        .unwrap();
    // `/model sonnet`: the statusline names another model, and the session's
    // running cost carries on from where it stood.
    held.extend(
        store
            .record(
                &per_model(
                    "sonnet",
                    Some(1.2),
                    &[("opus", 100.0, 1.0), ("sonnet", 30.0, 1.0)],
                    NOW + 60_000.0,
                ),
                &fresh,
                NOW + 60_000.0,
            )
            .unwrap(),
    );
    let cost: f64 = held.iter().filter_map(|row| row.cost_usd).sum();
    assert!(
        (cost - 1.2).abs() < 1e-9,
        "the session spent 1.2, not {cost}"
    );
    assert_eq!(
        by_model(&held),
        BTreeMap::from([
            ("opus".to_string(), (100.0, 1.0, 1)),
            ("sonnet".to_string(), (30.0, 0.2, 1)),
        ])
    );
}

#[test]
fn what_was_served_plus_what_was_booked_since_sums_to_the_ledger_per_model() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    let old = NOW - RAW_WINDOW_MS - 2.0 * HOUR;
    store
        .record(
            &per_model("opus", Some(1.0), &[("opus", 100.0, 1.0)], old),
            &fresh,
            old,
        )
        .unwrap();
    let served = store.ledger(NOW - HOUR).unwrap().rows;
    let mut held = served.clone();
    for report in [
        per_model(
            "opus",
            Some(1.0),
            &[("opus", 150.0, 2.0), ("haiku", 20.0, 1.0)],
            NOW - HOUR,
        ),
        per_model(
            "opus",
            Some(1.4),
            &[("opus", 150.0, 2.0), ("haiku", 20.0, 1.0)],
            NOW - HOUR + 1_000.0,
        ),
        per_model(
            "sonnet",
            Some(1.5),
            &[
                ("opus", 150.0, 2.0),
                ("haiku", 60.0, 4.0),
                ("sonnet", 10.0, 1.0),
            ],
            NOW - HOUR + 2_000.0,
        ),
    ] {
        let at = report.reported_at;
        held.extend(store.record(&report, &fresh, at).unwrap());
    }
    let reloaded = store.ledger(NOW).unwrap().rows;
    assert_eq!(totals(&held), totals(&reloaded));
    assert_eq!(by_model(&held), by_model(&reloaded));
    assert_eq!(
        by_model(&reloaded),
        BTreeMap::from([
            ("haiku".to_string(), (60.0, 0.0, 4)),
            ("opus".to_string(), (150.0, 1.4, 2)),
            ("sonnet".to_string(), (10.0, 0.1, 1)),
        ])
    );
}

#[test]
fn a_session_an_older_build_counted_as_one_sum_books_no_tokens_twice() {
    let (_dir, mut store) = store();
    let restored = context(SessionOrigin::Unknown);
    store
        .record(&report(Some(10_000.0), Some(4.0), NOW), &restored, NOW)
        .unwrap();
    // The new build's first count of the same session, per model.
    assert!(store
        .record(
            &per_model(
                "opus",
                Some(4.0),
                &[("opus", 9_000.0, 30.0), ("haiku", 1_000.0, 9.0)],
                NOW + 1_000.0
            ),
            &restored,
            NOW + 1_000.0,
        )
        .unwrap()
        .is_empty());
    let next = booked(
        store
            .record(
                &per_model(
                    "opus",
                    Some(4.0),
                    &[("opus", 9_050.0, 31.0), ("haiku", 1_000.0, 9.0)],
                    NOW + 2_000.0,
                ),
                &restored,
                NOW + 2_000.0,
            )
            .unwrap(),
    );
    assert_eq!((next.tokens.clone(), next.calls), (input(50.0), 1));
}

#[test]
fn a_store_of_the_previous_schema_is_migrated_and_its_events_are_one_call_each() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage.sqlite");
    {
        // The previous build's schema, and an event it booked.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE session (id INTEGER PRIMARY KEY, agent TEXT NOT NULL,
                 session_id TEXT NOT NULL, observation TEXT NOT NULL, UNIQUE (agent, session_id));
             CREATE TABLE event (event_id TEXT PRIMARY KEY, session INTEGER NOT NULL REFERENCES session(id),
                 occurred_at REAL NOT NULL, captured_at REAL NOT NULL, model TEXT, place TEXT NOT NULL,
                 tokens TEXT NOT NULL, cost_usd REAL);
             CREATE TABLE bucket (session INTEGER NOT NULL REFERENCES session(id), start REAL NOT NULL,
                 model TEXT NOT NULL, tokens TEXT NOT NULL, cost_pico INTEGER NOT NULL,
                 cost_events INTEGER NOT NULL, count INTEGER NOT NULL, calls INTEGER NOT NULL,
                 first_at REAL NOT NULL, last_at REAL NOT NULL, place TEXT NOT NULL,
                 PRIMARY KEY (session, start, model));
             INSERT INTO session VALUES (1, 'claude', 's-1', '{\"tokens\":{\"input\":5}}');
             PRAGMA user_version = 1;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO event VALUES ('usage-old', 1, ?1, ?1, 'Opus 5.5', ?2, '{\"input\":5}', NULL)",
            rusqlite::params![
                NOW,
                r#"{"workspaceId":"ws-1","workspaceName":"Deck","workspaceCwd":"/repo","paneId":"pane-1","paneName":"agent"}"#
            ],
        )
        .unwrap();
    }
    let store = UsageStore::open(&path, NOW).unwrap();
    let ledger = store.ledger(NOW + 1.0).unwrap();
    assert_eq!(ledger.rows.len(), 1);
    assert_eq!((ledger.rows[0].count, ledger.rows[0].calls), (1, 1));
    assert_eq!(
        ledger.per_model_since,
        Some(NOW),
        "the rows before it are the older build's"
    );
    drop(store);
    // Opened again later, it is the same store: the instant stays.
    let reopened = UsageStore::open(&path, NOW + HOUR).unwrap();
    assert_eq!(
        reopened.ledger(NOW + HOUR).unwrap().per_model_since,
        Some(NOW)
    );
    drop(reopened);
    let version: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 2);
}

#[test]
fn history_older_than_the_raw_window_is_served_as_buckets_and_counted_once() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    let old = NOW - RAW_WINDOW_MS - 2.0 * HOUR;
    store
        .record(&report(Some(100.0), Some(1.0), old), &fresh, old)
        .unwrap();
    store
        .record(
            &report(Some(130.0), Some(1.5), old + 60_000.0),
            &fresh,
            old + 60_000.0,
        )
        .unwrap();
    store
        .record(
            &report(Some(200.0), Some(2.0), NOW - HOUR),
            &fresh,
            NOW - HOUR,
        )
        .unwrap();

    let ledger = store.ledger(NOW).unwrap();
    assert_eq!(ledger.rows.len(), 2, "one bucket and one raw event");
    let bucket = &ledger.rows[0];
    assert_eq!(bucket.count, 2);
    assert_eq!(bucket.calls, 2);
    assert_eq!(bucket.cost_events, 2);
    assert_eq!(bucket.tokens, input(130.0));
    assert_eq!(bucket.cost_usd, Some(1.5));
    assert_eq!(bucket.cost_source, CostSource::Provider);
    assert_eq!(
        bucket.occurred_at,
        old + 60_000.0,
        "a bucket sits at its latest event"
    );
    let raw = &ledger.rows[1];
    assert_eq!(raw.count, 1);
    assert_eq!(raw.tokens, input(70.0));
    let total: f64 = ledger
        .rows
        .iter()
        .map(|row| row.tokens.input.unwrap())
        .sum();
    assert_eq!(total, 200.0, "every token once");
}

#[test]
fn a_store_of_a_newer_schema_is_refused_and_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage.sqlite");
    drop(UsageStore::open(&path, NOW).unwrap());
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("PRAGMA user_version = 99;")
        .unwrap();
    assert!(UsageStore::open(&path, NOW).is_err());
    let version: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 99);
}

fn line(at: f64, delta: &str, cost: Option<f64>, observation: &str) -> String {
    let cost = match cost {
        Some(usd) => format!(r#""costSource":"provider","costUsd":{usd},"#),
        None => r#""costSource":"unavailable","#.to_string(),
    };
    format!(
        r#"{{"schemaVersion":2,"eventId":"e-{at}","occurredAt":{at},"capturedAt":{at},"agent":"claude","model":"Opus","workspaceId":"ws-1","workspaceName":"Deck","workspaceCwd":"/repo","paneId":"pane-1","paneName":"agent","sessionId":"s-1","rootSessionId":"s-1","tokens":{delta},{cost}"observation":{observation}}}"#
    )
}

#[test]
fn an_import_cut_short_leaves_nothing_behind_to_book_twice() {
    // A resumed session, one token a line — more lines than any batch an
    // import might be tempted to commit on its own.
    let t = NOW - 240.0 * HOUR;
    let lines: Vec<String> = (1..=10_050u32)
        .map(|i| {
            line(
                t + f64::from(i) * 1_000.0,
                r#"{"input":1}"#,
                None,
                &format!(r#"{{"tokens":{{"input":{}}}}}"#, 10_000 + i),
            )
        })
        .collect();
    let whole = lines.join("\n");
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("usage-history.jsonl");

    // Cut short after its last good line — here by a line it cannot read.
    let mut torn = whole.clone().into_bytes();
    torn.extend_from_slice(b"\n\xff\xfe\n");
    std::fs::write(&file, &torn).unwrap();
    let (_dir, mut store) = store();
    assert!(import_jsonl(&mut store, &file, NOW).is_err());
    assert!(
        store.ledger(NOW).unwrap().rows.is_empty(),
        "the store is as it was"
    );

    // The next start imports the file again, and books what a clean one does.
    std::fs::write(&file, &whole).unwrap();
    import_jsonl(&mut store, &file, NOW).unwrap();
    let clean_file = dir.path().join("clean.jsonl");
    std::fs::write(&clean_file, &whole).unwrap();
    let (_clean_dir, mut clean) = self::store();
    import_jsonl(&mut clean, &clean_file, NOW).unwrap();
    let rows = store.ledger(NOW).unwrap().rows;
    assert_eq!(rows, clean.ledger(NOW).unwrap().rows);
    let booked: f64 = rows.iter().filter_map(|row| row.tokens.input).sum();
    assert_eq!(booked, 10_050.0, "one token a line, each line once");
}

#[test]
fn an_import_leaves_no_write_ahead_log_behind() {
    let t = NOW - 240.0 * HOUR;
    let lines: Vec<String> = (1..=500u32)
        .map(|i| {
            line(
                t + f64::from(i) * 1_000.0,
                r#"{"input":1}"#,
                None,
                &format!(r#"{{"tokens":{{"input":{}}}}}"#, 10_000 + i),
            )
        })
        .collect();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("usage-history.jsonl");
    std::fs::write(&file, lines.join("\n")).unwrap();
    let path = dir.path().join("usage.sqlite");
    let mut store = UsageStore::open(&path, NOW).unwrap();
    import_jsonl(&mut store, &file, NOW).unwrap();
    let log = std::fs::metadata(dir.path().join("usage.sqlite-wal")).unwrap();
    assert_eq!(
        log.len(),
        0,
        "everything the import wrote is in the database"
    );
}

#[test]
fn the_import_replays_the_old_ledger_and_corrects_what_it_got_wrong() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("usage-history.jsonl");
    let t = NOW - HOUR;
    let lines = [
        // A resumed session's first booked line: 40 on top of 10 000.
        line(t, r#"{"input":40}"#, None, r#"{"tokens":{"input":10040}}"#),
        // A recount dip the old ledger booked as a reset of the whole total.
        line(
            t + 60_000.0,
            r#"{"input":10030}"#,
            None,
            r#"{"tokens":{"input":10030}}"#,
        ),
        // A call's price, then its count a second later.
        line(
            t + 120_000.0,
            r#"{}"#,
            Some(0.5),
            r#"{"tokens":{"input":10030},"costUsd":0.5}"#,
        ),
        line(
            t + 121_000.0,
            r#"{"input":70}"#,
            None,
            r#"{"tokens":{"input":10100},"costUsd":0.5}"#,
        ),
        r#"{"schemaVersion":3,"eventId":"future"}"#.to_string(),
    ];
    std::fs::write(&file, lines.join("\n")).unwrap();

    let (_store_dir, mut store) = store();
    let report = import_jsonl(&mut store, &file, NOW).unwrap();
    assert_eq!(report.lines, 5);
    assert_eq!(report.withheld, 1);
    assert!(
        !file.exists(),
        "the file is kept aside, not left to import again"
    );
    assert!(report.kept_as.as_ref().unwrap().exists());

    let ledger = store.ledger(NOW).unwrap();
    assert!(
        !ledger.complete,
        "a withheld line leaves the store incomplete"
    );
    let booked: f64 = ledger.rows.iter().filter_map(|row| row.tokens.input).sum();
    // The session went from 10 000 to 10 100: 100 tokens. The old ledger
    // booked 40, then 10 030 for the dip, then 70 — 10 140.
    assert_eq!(
        booked, 100.0,
        "the dip books nothing, and growth counts from the high-water mark"
    );
    assert_eq!(
        ledger.rows.len(),
        3,
        "the first line, then the price and the count, each its own event"
    );
    let (price, count) = (&ledger.rows[1], &ledger.rows[2]);
    assert_eq!((price.cost_usd, price.calls), (Some(0.5), 0));
    assert_eq!((count.tokens.clone(), count.calls), (input(60.0), 1));

    // Once imported, never again.
    assert_eq!(import_jsonl(&mut store, &file, NOW).unwrap().lines, 0);
}

#[test]
fn the_ledger_says_when_it_began_booking_per_model() {
    let (_dir, store) = store();
    assert_eq!(
        store.ledger(NOW + HOUR).unwrap().per_model_since,
        Some(NOW),
        "a store this build creates books per model from the start"
    );
}
