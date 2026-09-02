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

use std::collections::{BTreeMap, HashMap};

use serde_json::{Number, Value};

use super::dialects::{at, TailSum};

/// One watch's running total: the sum so far, and — for a store that writes
/// one message as several rows — what each message has already contributed.
#[derive(Debug, Default, PartialEq, Eq)]
struct WatchFold {
    totals: BTreeMap<String, u64>,
    by_key: HashMap<String, BTreeMap<String, u64>>,
}

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
        let bucket = |path: &str| at(record, path).and_then(Value::as_u64).unwrap_or(0);

        match &sum.dedup_by {
            // Every row is its own event: it simply adds.
            None => {
                for (name, path) in &sum.buckets {
                    *state.totals.entry(name.clone()).or_default() += bucket(path);
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
                    let incoming = bucket(path);
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
