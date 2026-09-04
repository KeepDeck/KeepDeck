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

use serde_json::{Number, Value};

use super::dialects::{at, TailSum};

/// One watch's running total: the sum so far, and — for a store that writes
/// one message as several rows — what each message has already contributed.
#[derive(Debug, Default, PartialEq, Eq)]
struct WatchFold {
    totals: BTreeMap<String, u64>,
    by_key: HashMap<String, BTreeMap<String, u64>>,
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

    /// Fold one record into the total for `slot` and return the total to
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
        // `complained` and nothing else, which is the only reason the loops
        // below may still reach `totals` and `by_key` while it lives. Touch
        // another field of `state` in here and the borrow checker will refuse
        // the whole function rather than this line.
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

        match &sum.dedup_by {
            // Every row is its own event: it simply adds.
            None => {
                for (name, path) in &sum.buckets {
                    *state.totals.entry(name.clone()).or_default() += bucket(name, path);
                }
            }
            // Rows sharing an identity are ONE message restating itself as
            // its blocks arrive. Each bucket is held at that message's
            // maximum and only the growth joins the total — added plainly,
            // a turn would cost as many times as it had blocks.
            Some(key_path) => {
                let Some(key) = at(record, key_path).and_then(Value::as_str) else {
                    // No identity is no way to tell a repeat from a new
                    // message, and guessing wrong multiplies a turn's cost.
                    // The record still carries the total it did not change.
                    return stamp(&state.totals);
                };
                let held = state.by_key.entry(key.to_string()).or_default();
                for (name, path) in &sum.buckets {
                    let incoming = bucket(name, path);
                    let previous = held.get(name).copied().unwrap_or(0);
                    if incoming > previous {
                        held.insert(name.clone(), incoming);
                        *state.totals.entry(name.clone()).or_default() += incoming - previous;
                    }
                }
            }
        }
        stamp(&state.totals)
    }
}

/// The running total as the object it is stamped as. Buckets stay separate:
/// a re-read context prefix is not fresh input, and one number for both
/// would report a session as having spent what it merely re-sent.
fn stamp(totals: &BTreeMap<String, u64>) -> Value {
    Value::Object(
        totals
            .iter()
            .map(|(name, count)| (name.clone(), Value::Number(Number::from(*count))))
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
