//! The store through its public API, on a real file: what survives a reopen,
//! and what a reader that appends booked rows to the served ledger ends up
//! holding.

use std::collections::BTreeMap;

use keepdeck_usage::model::{CallTokens, Place};
use keepdeck_usage::pricing::{CostBasis, Price, PriceRow, Rates};
use keepdeck_usage::{CallBatch, LedgerRow, UsageCall, UsageStore};

const DAY: f64 = 86_400_000.0;
const NOW: f64 = 500.0 * DAY;

fn place() -> Place {
    Place {
        workspace_id: "ws".into(),
        workspace_name: "Workspace".into(),
        workspace_cwd: "/w".into(),
        pane_id: "pane-1".into(),
        pane_name: "claude".into(),
        worktree: None,
        team: None,
    }
}

fn opus() -> PriceRow {
    PriceRow {
        model: "anthropic/claude-opus-5-5".into(),
        from: 0.0,
        name: Some("Claude Opus 5.5".into()),
        price: Price {
            rates: Rates { input: 4.0, output: 20.0, cache_read: Some(0.2), cache_write: Some(5.0), cache_write_1h: None },
            tiers: Vec::new(),
            modes: BTreeMap::new(),
        },
    }
}

fn call(id: &str, at: f64, output: f64) -> UsageCall {
    UsageCall {
        id: id.into(),
        at,
        provider: "anthropic".into(),
        model: "claude-opus-5-5".into(),
        mode: None,
        tokens: CallTokens { input: 1_000.0, cache_read: 100_000.0, output, ..CallTokens::default() },
        tally: None,
    }
}

fn batch(calls: Vec<UsageCall>) -> CallBatch {
    CallBatch {
        agent: "claude".into(),
        session_id: "s1".into(),
        first_seen: NOW - 30.0 * DAY,
        place: place(),
        calls,
    }
}

fn cost(rows: &[LedgerRow]) -> f64 {
    rows.iter().filter_map(|row| row.cost_usd).sum()
}

fn output(rows: &[LedgerRow]) -> f64 {
    rows.iter().filter_map(|row| row.tokens.output).sum()
}

#[test]
fn calls_prices_and_first_sightings_survive_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage.sqlite");
    {
        let mut store = UsageStore::open(&path, NOW).unwrap();
        store.merge_prices(&[opus()], "seed", NOW).unwrap();
        store.book(&batch(vec![call("msg_1", NOW - 10.0 * DAY, 500.0)]), NOW).unwrap();
    }
    let mut store = UsageStore::open(&path, NOW).unwrap();
    let rows = store.ledger(NOW).unwrap().rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].cost_basis, CostBasis::Estimated, "the journal came back with the store");
    assert!(
        store.book(&batch(vec![call("msg_1", NOW - 10.0 * DAY, 500.0)]), NOW).unwrap().is_empty(),
        "a call booked before the reopen is still remembered"
    );
    assert_eq!(
        store.since("claude", "s1", NOW, NOW).unwrap(),
        NOW - 10.0 * DAY - keepdeck_usage::store::CATCH_UP_MARGIN_MS,
        "the first sighting and the newest call are still known"
    );
}

#[test]
fn what_was_served_plus_what_was_booked_since_is_the_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = UsageStore::open(&dir.path().join("usage.sqlite"), NOW).unwrap();
    store.merge_prices(&[opus()], "seed", NOW).unwrap();
    store
        .book(&batch(vec![call("old", NOW - 3.0 * DAY, 100.0), call("recent", NOW - 1_000.0, 200.0)]), NOW)
        .unwrap();
    let mut held = store.ledger(NOW).unwrap().rows;
    held.extend(store.book(&batch(vec![call("recent", NOW - 1_000.0, 260.0), call("new", NOW - 500.0, 40.0)]), NOW).unwrap());
    held.extend(store.book(&batch(vec![call("new", NOW - 500.0, 40.0)]), NOW).unwrap());
    let served = store.ledger(NOW).unwrap().rows;
    assert_eq!(output(&held), output(&served));
    assert!((cost(&held) - cost(&served)).abs() < 1e-9);
    assert_eq!(output(&served), 100.0 + 260.0 + 40.0);
    assert_eq!(held.iter().map(|r| r.calls).sum::<u32>(), 3);
}
