use keepdeck_usage::model::{
    CaptureContext, CostSource, SessionOrigin, TokenCounts, UsageReport, Worktree,
};
use keepdeck_usage::store::{BUCKET_MS, RAW_WINDOW_MS};
use keepdeck_usage::{import_jsonl, LedgerRow, UsageStore};

const HOUR: f64 = 3_600_000.0;
/// A quarter-hour boundary, so tests can place events inside one bucket.
const NOW: f64 = 1_790_000_100_000.0 - (1_790_000_100_000.0 % BUCKET_MS);

fn store() -> (tempfile::TempDir, UsageStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = UsageStore::open(&dir.path().join("usage.sqlite")).unwrap();
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
        reported_at: at,
        sequence: None,
    }
}

fn booked(row: Option<LedgerRow>) -> LedgerRow {
    row.expect("the report books a row")
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
    assert_eq!(
        store
            .record(&report(Some(100.0), None, NOW + 1.0), &fresh, NOW + 1.0)
            .unwrap(),
        None
    );
}

#[test]
fn a_resumed_session_seeds_its_base_and_books_only_what_follows() {
    let (_dir, mut store) = store();
    let resumed = context(SessionOrigin::Inherited);
    assert_eq!(
        store
            .record(&report(Some(10_000.0), None, NOW), &resumed, NOW)
            .unwrap(),
        None
    );
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
fn a_call_reported_in_two_halves_is_served_as_one_event() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    store
        .record(&report(Some(100.0), Some(1.0), NOW), &fresh, NOW)
        .unwrap();
    // The statusline prices the call first…
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
    // …and the transcript counts it 1.6 s later: a row that brings the
    // count to the call already booked, and is no call of its own.
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
    assert_eq!(counted.cost_usd, None);
    assert_eq!(
        (counted.count, counted.calls, counted.cost_events),
        (0, 0, 0)
    );
    assert_eq!(
        counted.occurred_at, priced.occurred_at,
        "placed in its call"
    );
    assert_ne!(counted.event_id, priced.event_id);

    let ledger = store.ledger(NOW + 10_000.0).unwrap();
    assert_eq!(ledger.rows.len(), 2, "the first report and the one call");
    let call = &ledger.rows[1];
    assert_eq!(call.event_id, priced.event_id, "the call keeps its id");
    assert_eq!(call.tokens, input(80.0));
    assert_eq!(call.cost_usd, Some(0.25));
    assert_eq!((call.count, call.calls, call.cost_events), (1, 1, 1));
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
    // A call priced then counted, and one counted then priced.
    for (tokens, cost, at) in [
        (100.0, 1.25, 5_000.0),
        (180.0, 1.25, 6_600.0),
        (260.0, 1.25, 20_000.0),
        (260.0, 1.75, 21_000.0),
    ] {
        held.push(booked(
            store
                .record(
                    &report(Some(tokens), Some(cost), NOW + at),
                    &fresh,
                    NOW + at,
                )
                .unwrap(),
        ));
    }
    let now = store.ledger(NOW + 30_000.0).unwrap().rows;
    assert_eq!(now.len(), 3, "the first report and two whole calls");
    assert_eq!(totals(&held), totals(&now));
    assert_eq!(totals(&now), (260.0, 1.75, 3, 3, 3));
}

#[test]
fn halves_further_apart_than_the_pair_window_stay_two_events() {
    let (_dir, mut store) = store();
    let fresh = context(SessionOrigin::Fresh);
    store
        .record(&report(Some(100.0), Some(1.0), NOW), &fresh, NOW)
        .unwrap();
    store
        .record(
            &report(Some(100.0), Some(1.25), NOW + 5_000.0),
            &fresh,
            NOW + 5_000.0,
        )
        .unwrap();
    booked(
        store
            .record(
                &report(Some(180.0), Some(1.25), NOW + 9_000.0),
                &fresh,
                NOW + 9_000.0,
            )
            .unwrap(),
    );
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
    drop(UsageStore::open(&path).unwrap());
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("PRAGMA user_version = 99;")
        .unwrap();
    assert!(UsageStore::open(&path).is_err());
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
        // One call in halves: priced, then counted a second later.
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
        2,
        "the first line, and the call made whole"
    );
    let call = &ledger.rows[1];
    assert_eq!(call.tokens, input(60.0));
    assert_eq!(call.cost_usd, Some(0.5));

    // Once imported, never again.
    assert_eq!(import_jsonl(&mut store, &file, NOW).unwrap().lines, 0);
}
