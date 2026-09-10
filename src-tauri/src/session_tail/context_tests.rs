use serde_json::json;
use std::fs;

use super::dialects::{last_of_each, watched_events, TailWatch};
use super::reader::{drain_file, TailCursor};
use super::route::{route, wrap, Routed};
use super::test_support::temp_dir;
use super::totals::Folds;

fn watches() -> Vec<TailWatch> {
    serde_json::from_value(json!([
        {"match":[{"key":"type","equals":"context"}],"keep":["model"],"lane":"usage"},
        {"match":[{"key":"type","equals":"context"}],"keep":["mode","time"],"lane":"status","replayContext":true},
        {"match":[{"key":"type","equals":"end"}],"keep":["type"],"lane":"status"},
        {"match":[{"key":"type","equals":"context"}],"keep":["private"],"lane":"status"}
    ])).unwrap()
}

#[test]
fn one_line_can_feed_both_lanes_without_duplicates_or_extra_fields() {
    let events = watched_events(
        br#"{"type":"context","model":"model","mode":"plan","time":100,"private":"secret"}"#,
        &watches(),
        &mut Folds::default(),
    );
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].payload["record"], json!({"model":"model"}));
    assert_eq!(
        events[1].payload["record"],
        json!({"mode":"plan","time":100})
    );
    assert_eq!(events[1].slot, Some(1));
}

#[test]
fn a_cold_file_restores_only_latest_context_and_never_its_old_ending() {
    let dir = temp_dir();
    let path = dir.join("wire.jsonl");
    fs::write(
        &path,
        concat!(
            "{\"type\":\"context\",\"model\":\"old\",\"mode\":\"default\",\"time\":100}\n",
            "{\"type\":\"context\",\"model\":\"new\",\"mode\":\"plan\",\"time\":200}\n",
            "{\"type\":\"end\",\"time\":300}\n"
        ),
    )
    .unwrap();
    let watches = watches();
    let (events, rotated) = drain_file(
        &path,
        &mut TailCursor::default(),
        &watches,
        &mut Folds::default(),
        true,
    );
    assert!(!rotated);
    let events = last_of_each(events, &watches);
    assert_eq!(events.len(), 2);
    let reports: Vec<_> = events
        .into_iter()
        .map(|event| route(wrap("pane", "token", "agent", event, true)))
        .collect();
    assert!(matches!(&reports[0], Routed::Usage(_)));
    let Routed::Status(report) = &reports[1] else {
        panic!("context must reach the decoder")
    };
    assert_eq!(report.payload["contextOnly"], true);
    assert_eq!(report.payload["record"], json!({"mode":"plan","time":200}));
    let old_end = watched_events(br#"{"type":"end"}"#, &watches, &mut Folds::default())
        .pop()
        .unwrap();
    assert_eq!(
        route(wrap("pane", "token", "agent", old_end, true)),
        Routed::Drop
    );
    fs::remove_dir_all(dir).unwrap();
}
