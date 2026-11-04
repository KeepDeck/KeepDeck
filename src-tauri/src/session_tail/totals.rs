//! The running totals a dialect asked for, folded over the records its
//! watches carry. Pure arithmetic over named buckets — this module cannot
//! tell tokens from any other number, and does not need to.
//!
//! It used to hold one arm per agent: kimi summed its per-request rows,
//! claude deduplicated repeated assistant rows by message id and kept each
//! bucket's maximum, codex was passed over because it carries a cumulative
//! of its own. Three CLIs' accounting rules, written into the side that
//! reads the bytes. The rules are declarations now ([`TailSum`]); what is
//! left here is the adding.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{Map, Number, Value};

use super::dialects::{at, TailSum};

/// One total: the sum of each bucket, how many messages went into it, and —
/// for a store that writes one message as several rows — what each message
/// has already contributed.
///
/// A message's contribution is held in the total of its group, so a message
/// is assumed to stay in one group: rows restating it under another value of
/// the grouping field would count it in each. Claude's restated rows carry
/// the message's model unchanged.
#[derive(Debug, Default, PartialEq, Eq)]
struct Total {
    sums: BTreeMap<String, u64>,
    messages: u64,
    by_key: HashMap<String, BTreeMap<String, u64>>,
}

/// One watch's running totals, one per group (a single one under the empty
/// name when the sum declares no grouping), and the buckets that have been
/// failing to read.
#[derive(Debug, Default, PartialEq, Eq)]
struct WatchFold {
    totals: BTreeMap<String, Total>,
    /// Consecutive records in which a bucket's path did not read as a number,
    /// and the buckets already complained about. See [`BUCKET_SILENT_FOR`].
    misses: BTreeMap<String, u32>,
    complained: BTreeSet<String>,
}

/// How many records in a row a bucket may fail to resolve before the reader
/// says so out loud.
///
/// A bucket missing from ONE record is ordinary — a store need not report
/// every count on every line. A bucket missing from every record in a row is
/// a path that does not exist: a typo in the declaration, or a field the CLI
/// renamed. Both read as zero, both under-report spend forever, and neither
/// leaves a trace — the user sees a number that is too small and there is
/// nothing to look at. The threshold is what separates the two, and it is
/// generous because a false complaint costs more than a late one.
const BUCKET_SILENT_FOR: u32 = 20;

/// Every fold of one followed session, keyed by the watch that declared it.
///
/// Keyed rather than sized, so nothing has to be told how many watches there
/// are: a fold appears the first time its watch carries something, and a
/// watch that declared no sum never makes one.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Folds {
    per_watch: HashMap<usize, WatchFold>,
}

impl Folds {
    /// Start over. A rotated store is a new session generation, and totals
    /// carried across it would add a finished session to a fresh one.
    pub(super) fn reset(&mut self) {
        self.per_watch.clear();
    }

    /// Fold one record into the total for `slot` and return the totals to
    /// stamp on it.
    ///
    /// The record is the ORIGINAL, not the projection a watch keeps: a
    /// dialect should not have to carry a field out of its store merely to
    /// have it counted.
    pub(super) fn fold(&mut self, slot: usize, sum: &TailSum, record: &Value) -> Value {
        let state = self.per_watch.entry(slot).or_default();
        // Read a bucket, and keep score of the ones that never read. The
        // arithmetic treats an unreadable path as zero — it has nothing
        // better to do with it — so the only defence against a wrong path is
        // that somebody eventually hears about it.
        //
        // CAVEAT for the next editor: this closure borrows `misses` and
        // `complained` and nothing else, which is the only reason the code
        // below may still reach `totals` while it lives. Touch another field
        // of `state` in here and the borrow checker will refuse the whole
        // function rather than this line.
        let mut bucket = |name: &str, path: &str| match at(record, path).and_then(Value::as_u64) {
            Some(count) => {
                state.misses.insert(name.to_string(), 0);
                count
            }
            None => {
                let missed = state.misses.entry(name.to_string()).or_default();
                *missed += 1;
                if *missed >= BUCKET_SILENT_FOR && state.complained.insert(name.to_string()) {
                    log::warn!(
                        "session tail: bucket {name:?} has read as nothing for {missed} records \
                         in a row at {path:?} — the total for it is being under-counted"
                    );
                }
                0
            }
        };

        let key = match &sum.dedup_by {
            None => None,
            Some(key_path) => match at(record, key_path).and_then(Value::as_str) {
                Some(key) => Some(key),
                // No identity is no way to tell a repeat from a new
                // message, and guessing wrong multiplies a turn's cost.
                // The record still carries the totals it did not change.
                None => return stamp(&state.totals, sum),
            },
        };
        let group = sum
            .group_by
            .as_deref()
            .and_then(|path| at(record, path))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let total = state.totals.entry(group.to_string()).or_default();

        match key {
            // Every row is its own event: it simply adds.
            None => {
                total.messages += 1;
                for (name, path) in &sum.buckets {
                    *total.sums.entry(name.clone()).or_default() += bucket(name, path);
                }
            }
            // Rows sharing an identity are ONE message restating itself as
            // its blocks arrive. Each bucket is held at that message's
            // maximum and only the growth joins the total — added plainly,
            // a turn would cost as many times as it had blocks.
            Some(key) => {
                if !total.by_key.contains_key(key) {
                    total.messages += 1;
                }
                let held = total.by_key.entry(key.to_string()).or_default();
                for (name, path) in &sum.buckets {
                    let incoming = bucket(name, path);
                    let previous = held.get(name).copied().unwrap_or(0);
                    if incoming > previous {
                        held.insert(name.clone(), incoming);
                        *total.sums.entry(name.clone()).or_default() += incoming - previous;
                    }
                }
            }
        }
        stamp(&state.totals, sum)
    }
}

/// The running totals as the object they are stamped as: one total, or one
/// per group under its name. Buckets stay separate: a re-read context prefix
/// is not fresh input, and one number for both would report a session as
/// having spent what it merely re-sent.
fn stamp(totals: &BTreeMap<String, Total>, sum: &TailSum) -> Value {
    let one = |total: &Total| {
        let mut object: Map<String, Value> = total
            .sums
            .iter()
            .map(|(name, count)| (name.clone(), Value::Number(Number::from(*count))))
            .collect();
        if let Some(name) = &sum.count_as {
            object.insert(name.clone(), Value::Number(Number::from(total.messages)));
        }
        Value::Object(object)
    };
    if sum.group_by.is_none() {
        return totals
            .get("")
            .map_or_else(|| Value::Object(Map::new()), one);
    }
    Value::Object(
        totals
            .iter()
            .map(|(group, total)| (group.clone(), one(total)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sum(dedup_by: Option<&str>) -> TailSum {
        TailSum {
            buckets: BTreeMap::from([
                ("input".to_string(), "usage.input".to_string()),
                ("output".to_string(), "usage.output".to_string()),
            ]),
            dedup_by: dedup_by.map(str::to_string),
            group_by: None,
            count_as: None,
            stamp_as: "sessionTotals".to_string(),
        }
    }

    fn record(id: &str, input: u64, output: u64) -> Value {
        serde_json::json!({ "id": id, "usage": { "input": input, "output": output } })
    }

    #[test]
    fn a_plain_sum_adds_each_bucket_separately() {
        let mut folds = Folds::default();
        let declared = sum(None);

        let first = folds.fold(0, &declared, &record("a", 1200, 300));
        assert_eq!(first, serde_json::json!({ "input": 1200, "output": 300 }));

        let second = folds.fold(0, &declared, &record("b", 800, 50));
        assert_eq!(second, serde_json::json!({ "input": 2000, "output": 350 }));
    }

    #[test]
    fn folds_of_different_watches_do_not_mix() {
        let mut folds = Folds::default();
        let declared = sum(None);
        folds.fold(0, &declared, &record("a", 10, 1));
        let other = folds.fold(1, &declared, &record("a", 5, 2));
        // Slot 1 counts only what slot 1 carried.
        assert_eq!(other, serde_json::json!({ "input": 5, "output": 2 }));
    }

    #[test]
    fn repeated_rows_of_one_message_advance_to_the_maximum_only() {
        let mut folds = Folds::default();
        let declared = sum(Some("id"));

        assert_eq!(
            folds.fold(0, &declared, &record("msg-1", 12, 30)),
            serde_json::json!({ "input": 12, "output": 30 })
        );
        // The same message restated as another block arrives: output grew,
        // input did not, and neither is added a second time.
        assert_eq!(
            folds.fold(0, &declared, &record("msg-1", 12, 45)),
            serde_json::json!({ "input": 12, "output": 45 })
        );
        // A row that reports LESS than the message already showed cannot
        // pull the total back down.
        assert_eq!(
            folds.fold(0, &declared, &record("msg-1", 12, 8)),
            serde_json::json!({ "input": 12, "output": 45 })
        );
        // A different message contributes its own maxima on top.
        assert_eq!(
            folds.fold(0, &declared, &record("msg-2", 2, 5)),
            serde_json::json!({ "input": 14, "output": 50 })
        );
    }

    #[test]
    fn a_row_with_no_identity_is_counted_by_neither_rule() {
        let mut folds = Folds::default();
        let declared = sum(Some("id"));
        folds.fold(0, &declared, &record("msg-1", 12, 30));

        let anonymous = serde_json::json!({ "usage": { "input": 999, "output": 999 } });
        assert_eq!(
            folds.fold(0, &declared, &anonymous),
            serde_json::json!({ "input": 12, "output": 30 }),
            "an unattributable row must not be able to multiply a turn's cost"
        );
    }

    #[test]
    fn a_missing_bucket_reads_as_zero_rather_than_stopping_the_fold() {
        let mut folds = Folds::default();
        let declared = sum(None);
        let partial = serde_json::json!({ "usage": { "output": 7 } });
        assert_eq!(
            folds.fold(0, &declared, &partial),
            serde_json::json!({ "input": 0, "output": 7 })
        );
    }

    #[test]
    fn a_bucket_that_never_resolves_does_not_disturb_the_ones_that_do() {
        // A path that reads as nothing is counted as zero — there is nothing
        // better to do with it — and past a run of them the reader says so in
        // the log. What must NOT happen is the complaint costing the fold its
        // arithmetic, or the miss counter leaking into the totals.
        let mut folds = Folds::default();
        let declared = TailSum {
            buckets: BTreeMap::from([
                ("output".to_string(), "usage.output".to_string()),
                ("typo".to_string(), "usage.ouptut".to_string()),
            ]),
            dedup_by: None,
            group_by: None,
            count_as: None,
            stamp_as: "sessionTotals".to_string(),
        };

        let mut last = Value::Null;
        for _ in 0..(BUCKET_SILENT_FOR + 5) {
            last = folds.fold(0, &declared, &record("a", 0, 3));
        }
        assert_eq!(
            last,
            serde_json::json!({ "output": 75, "typo": 0 }),
            "the readable bucket keeps its arithmetic; the unreadable one stays zero"
        );

        // And a bucket that starts reading again is forgiven: the run is what
        // is counted, not the lifetime.
        let readable = TailSum {
            buckets: BTreeMap::from([("typo".to_string(), "usage.output".to_string())]),
            dedup_by: None,
            group_by: None,
            count_as: None,
            stamp_as: "sessionTotals".to_string(),
        };
        let after = folds.fold(0, &readable, &record("a", 0, 4));
        assert_eq!(after["typo"], 4);
    }

    #[test]
    fn only_a_whole_non_negative_number_reads_as_a_count() {
        // The buckets are counts, so the reader takes unsigned integers and
        // nothing else. A float, a negative or a numeric STRING is not a
        // near-miss to be coerced — it is a store reporting something this
        // fold was not told how to add, and coercing it would invent a
        // number nobody wrote. It reads as nothing, which the run counter
        // then reports on if it keeps happening.
        let declared = TailSum {
            buckets: BTreeMap::from([("n".to_string(), "usage.n".to_string())]),
            dedup_by: None,
            group_by: None,
            count_as: None,
            stamp_as: "sessionTotals".to_string(),
        };
        for odd in [
            serde_json::json!(1.5),
            serde_json::json!(-3),
            serde_json::json!("7"),
            serde_json::json!(null),
        ] {
            let record = serde_json::json!({ "usage": { "n": odd } });
            assert_eq!(
                Folds::default().fold(0, &declared, &record)["n"],
                0,
                "{odd} is not a count"
            );
        }
        // ...and a whole one still counts, so the rule is about the VALUE
        // rather than about the path having gone wrong.
        let record = serde_json::json!({ "usage": { "n": 7 } });
        assert_eq!(Folds::default().fold(0, &declared, &record)["n"], 7);
    }

    /// A claude-shaped declaration: one total per model, a message counted
    /// once however many rows restate it.
    fn per_model() -> TailSum {
        TailSum {
            group_by: Some("model".to_string()),
            count_as: Some("messages".to_string()),
            ..sum(Some("id"))
        }
    }

    fn row(id: &str, model: &str, input: u64, output: u64) -> Value {
        serde_json::json!({
            "id": id, "model": model, "usage": { "input": input, "output": output }
        })
    }

    #[test]
    fn a_grouped_sum_keeps_one_total_per_value() {
        let mut folds = Folds::default();
        let declared = per_model();
        folds.fold(0, &declared, &row("m-1", "opus", 100, 10));
        // The same message restated as its blocks arrive: one message still.
        folds.fold(0, &declared, &row("m-1", "opus", 100, 25));
        folds.fold(0, &declared, &row("m-2", "haiku", 7, 3));
        let last = folds.fold(0, &declared, &row("m-3", "opus", 40, 5));
        assert_eq!(
            last,
            serde_json::json!({
                "opus": { "input": 140, "output": 30, "messages": 2 },
                "haiku": { "input": 7, "output": 3, "messages": 1 },
            })
        );
    }

    #[test]
    fn a_row_without_the_group_field_is_totalled_under_the_empty_name() {
        let mut folds = Folds::default();
        let declared = per_model();
        folds.fold(0, &declared, &row("m-1", "opus", 1, 1));
        let unnamed = serde_json::json!({ "id": "m-2", "usage": { "input": 5, "output": 2 } });
        assert_eq!(
            folds.fold(0, &declared, &unnamed),
            serde_json::json!({
                "opus": { "input": 1, "output": 1, "messages": 1 },
                "": { "input": 5, "output": 2, "messages": 1 },
            })
        );
    }

    #[test]
    fn a_message_count_without_identities_counts_the_rows() {
        let mut folds = Folds::default();
        let declared = TailSum {
            count_as: Some("messages".to_string()),
            ..sum(None)
        };
        folds.fold(0, &declared, &record("a", 1, 1));
        assert_eq!(
            folds.fold(0, &declared, &record("a", 2, 2)),
            serde_json::json!({ "input": 3, "output": 3, "messages": 2 }),
            "every row is its own event, so every row is counted"
        );
    }

    #[test]
    fn a_row_with_no_identity_is_no_message() {
        let mut folds = Folds::default();
        let declared = per_model();
        folds.fold(0, &declared, &row("m-1", "opus", 1, 1));
        let anonymous =
            serde_json::json!({ "model": "opus", "usage": { "input": 9, "output": 9 } });
        assert_eq!(
            folds.fold(0, &declared, &anonymous),
            serde_json::json!({ "opus": { "input": 1, "output": 1, "messages": 1 } })
        );
    }

    #[test]
    fn a_reset_starts_the_session_over() {
        let mut folds = Folds::default();
        let declared = sum(None);
        folds.fold(0, &declared, &record("a", 1200, 300));
        folds.reset();
        assert_eq!(
            folds.fold(0, &declared, &record("a", 5, 5)),
            serde_json::json!({ "input": 5, "output": 5 }),
            "a rotated store is a new session, not a continuation"
        );
    }
}
