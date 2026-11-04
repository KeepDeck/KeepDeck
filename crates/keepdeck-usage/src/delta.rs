//! Cumulative report → durable delta. The one place that knows how a
//! provider's growing counters become the non-negative increments the
//! ledger stores: the reset rule, the noise rule and the resumed-session
//! rule.

use std::collections::BTreeMap;

use crate::model::{ModelCounters, Observation, TokenCounts, TOKEN_KINDS};

/// A counter that falls by less than this share of its previous value is
/// noise, not a reset.
///
/// Providers recount now and then — a duplicate message dropped from a
/// session's total — and the counter steps back by a few thousand out of
/// billions. Taken as a reset, such a dip books the whole running total
/// again: one cacheRead counter that fell by 2 423 at 2.92 billion was
/// counted as 2.92 billion new tokens, and four such dips put 3.6 billion
/// phantom tokens (3.1% of everything) in the ledger. A real reset falls to
/// a sliver of where it was (69.8 million to 22.7 thousand). So a fall of
/// less than a tenth is noise: nothing is booked, and the base stays at the
/// high-water mark until the counter passes it again.
pub const NOISE_DIP: f64 = 0.1;

/// What a report's cost adds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DeltaCost {
    /// The provider priced it, in USD.
    Provider(f64),
    Unavailable,
}

/// What one model's counters add.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelDelta {
    pub tokens: TokenCounts,
    pub calls: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Delta {
    /// What a report counting the session as one sum adds — or, on the
    /// first per-model report of a session an older build counted as one
    /// sum, what its models gained past that sum.
    pub tokens: TokenCounts,
    pub cost: DeltaCost,
    /// What each model's counters add, for a report counting per model.
    /// Only the models that moved.
    pub models: BTreeMap<String, ModelDelta>,
    /// The base the next report is measured against.
    pub observation: Observation,
}

impl Delta {
    /// Nothing to book: no counter moved and nothing was priced.
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty() && self.cost == DeltaCost::Unavailable && self.models.is_empty()
    }
}

/// Money is kept to the picodollar: float sums drift below that, and a
/// rounded value compares equal however it was summed.
pub fn round_money(value: f64) -> f64 {
    (value * 1e12).round() / 1e12
}

fn finite_non_negative(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v >= 0.0)
}

/// How a counter moved from `before` to `value`: what to book, and the base
/// to keep. `None` books nothing.
fn movement(value: f64, before: Option<f64>) -> (Option<f64>, f64) {
    match before {
        None => (Some(value), value),
        Some(before) if value >= before => (Some(value - before), value),
        Some(before) if value >= before * (1.0 - NOISE_DIP) => (None, before),
        Some(_) => (Some(value), value),
    }
}

/// Move one counter's base to `value`, and answer what that books. `seed`
/// books nothing for a counter that had no base: it only starts one.
fn advance(base: &mut Option<f64>, value: Option<f64>, seed: bool) -> Option<f64> {
    let value = finite_non_negative(value)?;
    let before = finite_non_negative(*base);
    let (booked, kept) = movement(value, before);
    *base = Some(kept);
    if seed && before.is_none() {
        return None;
    }
    booked
}

/// Move token bases to `current` kind by kind, and answer what that books.
fn advance_tokens(base: &mut TokenCounts, current: &TokenCounts, seed: bool) -> TokenCounts {
    let mut booked = TokenCounts::default();
    for kind in TOKEN_KINDS {
        let mut held = base.get(kind);
        let moved = advance(&mut held, current.get(kind), seed);
        base.set(kind, held);
        booked.set(kind, moved.filter(|b| *b > 0.0));
    }
    booked
}

/// Convert a cumulative report into a non-negative delta against `previous`.
///
/// `baseline_only` seeds each dimension of a resumed session that has no
/// base yet: its lifetime counters and cost become the base and nothing is
/// booked for them. Tokens and cost may arrive in separate reports, so each
/// dimension seeds on its own.
///
/// A report counting per model (`by_model`) is booked per model, and its
/// one-sum `total_tokens` — the same tokens again — is not booked at all.
/// Its models start as a base, booking nothing, when the session has no
/// model counted yet and either it is resumed, or an older build already
/// counted its tokens as one sum. Those tokens are in the ledger up to that
/// sum, so what the models hold past it — messages that arrived after the
/// older build's last booking — is booked once, as one sum, before the
/// models take over. Once a session counts per model, a model it has not
/// seen is new usage, counted from nothing — a subagent starting on
/// another model.
///
/// The cost stays the session's whatever model it is reported under: kept
/// per model, a switch of model would book the whole running cost again.
pub fn usage_delta(
    total_tokens: Option<&TokenCounts>,
    cost_usd: Option<f64>,
    by_model: Option<&BTreeMap<String, ModelCounters>>,
    previous: Option<&Observation>,
    baseline_only: bool,
) -> Delta {
    let mut observation = previous.cloned().unwrap_or_default();

    let previous_cost = finite_non_negative(observation.cost_usd);
    let mut cost = DeltaCost::Unavailable;
    if let Some(booked) = advance(&mut observation.cost_usd, cost_usd, baseline_only) {
        // A base with no movement books nothing; a first price books even
        // zero — an explicit "this cost nothing" is a priced event.
        if previous_cost.is_none() || booked > 0.0 {
            cost = DeltaCost::Provider(round_money(booked));
        }
    }

    let mut tokens = TokenCounts::default();
    let mut models = BTreeMap::new();
    match by_model {
        None => {
            if let Some(current) = total_tokens {
                tokens = advance_tokens(&mut observation.tokens, current, baseline_only);
            }
        }
        Some(by_model) => {
            let first = observation.models.is_empty();
            let counted_as_one = first && !observation.tokens.is_empty();
            if counted_as_one {
                let mut sum = TokenCounts::default();
                for current in by_model.values() {
                    sum.add(&current.total_tokens);
                }
                tokens = advance_tokens(&mut observation.tokens, &sum, false);
            }
            let seed = first && (baseline_only || counted_as_one);
            for (model, current) in by_model {
                let base = observation.models.entry(model.clone()).or_default();
                let moved = ModelDelta {
                    tokens: advance_tokens(&mut base.total_tokens, &current.total_tokens, seed),
                    calls: advance(&mut base.calls, current.calls, seed).unwrap_or(0.0),
                };
                if !moved.tokens.is_empty() || moved.calls > 0.0 {
                    models.insert(model.clone(), moved);
                }
            }
        }
    }

    Delta {
        tokens,
        cost,
        models,
        observation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(pairs: &[(crate::model::TokenKind, f64)]) -> TokenCounts {
        let mut counts = TokenCounts::default();
        for (kind, value) in pairs {
            counts.set(*kind, Some(*value));
        }
        counts
    }

    fn observation(pairs: &[(crate::model::TokenKind, f64)], cost: Option<f64>) -> Observation {
        Observation {
            tokens: tokens(pairs),
            cost_usd: cost,
            ..Observation::default()
        }
    }

    /// A report counting the session as one sum.
    fn one_sum(
        total_tokens: Option<&TokenCounts>,
        cost_usd: Option<f64>,
        previous: Option<&Observation>,
        baseline_only: bool,
    ) -> Delta {
        usage_delta(total_tokens, cost_usd, None, previous, baseline_only)
    }

    fn counters(input: f64, calls: f64) -> ModelCounters {
        ModelCounters {
            total_tokens: tokens(&[(Input, input)]),
            calls: Some(calls),
        }
    }

    fn per_model(models: &[(&str, f64, f64)]) -> BTreeMap<String, ModelCounters> {
        models
            .iter()
            .map(|(model, input, calls)| (model.to_string(), counters(*input, *calls)))
            .collect()
    }

    fn moved(input: f64, calls: f64) -> ModelDelta {
        ModelDelta {
            tokens: tokens(&[(Input, input)]),
            calls,
        }
    }

    use crate::model::TokenKind::{CacheRead, Input, Output};

    #[test]
    fn turns_cumulative_token_and_cost_snapshots_into_deltas() {
        let delta = one_sum(
            Some(&tokens(&[(Input, 150.0), (Output, 20.0)])),
            Some(1.5),
            Some(&observation(&[(Input, 100.0), (Output, 5.0)], Some(1.0))),
            false,
        );
        assert_eq!(delta.tokens, tokens(&[(Input, 50.0), (Output, 15.0)]));
        assert_eq!(delta.cost, DeltaCost::Provider(0.5));
        assert_eq!(
            delta.observation,
            observation(&[(Input, 150.0), (Output, 20.0)], Some(1.5))
        );
    }

    #[test]
    fn treats_a_steep_fall_as_a_reset_and_keeps_absent_baselines() {
        let delta = one_sum(
            Some(&tokens(&[(Input, 20.0)])),
            None,
            Some(&observation(&[(Input, 100.0), (Output, 7.0)], Some(2.0))),
            false,
        );
        assert_eq!(delta.tokens, tokens(&[(Input, 20.0)]));
        assert_eq!(delta.cost, DeltaCost::Unavailable);
        assert_eq!(
            delta.observation,
            observation(&[(Input, 20.0), (Output, 7.0)], Some(2.0))
        );
    }

    #[test]
    fn a_real_reset_from_the_ledger_books_the_new_count() {
        let delta = one_sum(
            Some(&tokens(&[(Input, 22_755.0)])),
            None,
            Some(&observation(&[(Input, 69_779_364.0)], None)),
            false,
        );
        assert_eq!(delta.tokens, tokens(&[(Input, 22_755.0)]));
        assert_eq!(delta.observation.tokens.input, Some(22_755.0));
    }

    #[test]
    fn a_small_dip_books_nothing_and_keeps_the_high_water_mark() {
        // The ledger's worst case: 2 423 tokens of recount at 2.92 billion.
        let base = observation(&[(CacheRead, 2_924_098_014.0)], None);
        let dip = one_sum(
            Some(&tokens(&[(CacheRead, 2_924_095_591.0)])),
            None,
            Some(&base),
            false,
        );
        assert!(dip.is_empty(), "a recount is not usage");
        assert_eq!(dip.observation.tokens.cache_read, Some(2_924_098_014.0));

        // Growth is booked from the high-water mark, never from the dip.
        let grown = one_sum(
            Some(&tokens(&[(CacheRead, 2_924_100_000.0)])),
            None,
            Some(&dip.observation),
            false,
        );
        assert_eq!(grown.tokens, tokens(&[(CacheRead, 1_986.0)]));
    }

    #[test]
    fn a_small_cost_dip_prices_nothing_and_keeps_the_high_water_mark() {
        let dip = one_sum(None, Some(9.9), Some(&observation(&[], Some(10.0))), false);
        assert_eq!(dip.cost, DeltaCost::Unavailable);
        assert_eq!(dip.observation.cost_usd, Some(10.0));
    }

    #[test]
    fn recognizes_duplicate_cumulative_observations() {
        let delta = one_sum(
            Some(&tokens(&[(Input, 10.0)])),
            Some(1.0),
            Some(&observation(&[(Input, 10.0)], Some(1.0))),
            false,
        );
        assert!(delta.is_empty());
    }

    #[test]
    fn seeds_a_resumed_session_without_backfilling_lifetime_usage() {
        let delta = one_sum(
            Some(&tokens(&[(Input, 100.0), (Output, 10.0)])),
            Some(9.0),
            None,
            true,
        );
        assert!(delta.is_empty());
        assert_eq!(
            delta.observation,
            observation(&[(Input, 100.0), (Output, 10.0)], Some(9.0))
        );
    }

    #[test]
    fn seeds_independently_arriving_resumed_cost_and_token_dimensions() {
        let cost = one_sum(None, Some(9.0), None, true);
        assert!(cost.is_empty());
        assert_eq!(cost.observation, observation(&[], Some(9.0)));

        let counted = one_sum(
            Some(&tokens(&[(Input, 100.0), (Output, 10.0)])),
            None,
            Some(&cost.observation),
            true,
        );
        assert!(counted.is_empty());
        assert_eq!(
            counted.observation,
            observation(&[(Input, 100.0), (Output, 10.0)], Some(9.0))
        );

        let later = one_sum(
            Some(&tokens(&[(Input, 105.0), (Output, 12.0)])),
            Some(9.5),
            Some(&counted.observation),
            true,
        );
        assert_eq!(later.tokens, tokens(&[(Input, 5.0), (Output, 2.0)]));
        assert_eq!(later.cost, DeltaCost::Provider(0.5));
    }

    #[test]
    fn preserves_an_explicit_initial_provider_cost_of_zero() {
        let first = one_sum(None, Some(0.0), None, false);
        assert_eq!(first.cost, DeltaCost::Provider(0.0));
        assert!(!first.is_empty());
        assert!(one_sum(None, Some(0.0), Some(&observation(&[], Some(0.0))), false).is_empty());
    }

    #[test]
    fn a_report_counting_per_model_books_each_model_and_not_its_sum() {
        let first = usage_delta(
            Some(&tokens(&[(Input, 999.0)])),
            None,
            Some(&per_model(&[("opus", 100.0, 2.0), ("haiku", 30.0, 1.0)])),
            None,
            false,
        );
        assert!(first.tokens.is_empty(), "the sum is the same tokens again");
        assert_eq!(
            first.models,
            BTreeMap::from([
                ("haiku".to_string(), moved(30.0, 1.0)),
                ("opus".to_string(), moved(100.0, 2.0)),
            ])
        );

        let next = usage_delta(
            None,
            None,
            Some(&per_model(&[("opus", 160.0, 3.0), ("haiku", 30.0, 1.0)])),
            Some(&first.observation),
            false,
        );
        assert_eq!(
            next.models,
            BTreeMap::from([("opus".to_string(), moved(60.0, 1.0))]),
            "only the model that moved"
        );
    }

    #[test]
    fn a_message_growing_without_a_new_one_books_tokens_and_no_call() {
        let first = usage_delta(
            None,
            None,
            Some(&per_model(&[("opus", 100.0, 1.0)])),
            None,
            false,
        );
        let grown = usage_delta(
            None,
            None,
            Some(&per_model(&[("opus", 120.0, 1.0)])),
            Some(&first.observation),
            false,
        );
        assert_eq!(grown.models["opus"], moved(20.0, 0.0));
    }

    #[test]
    fn a_resumed_session_seeds_its_models_then_counts_a_new_one_from_nothing() {
        let seeded = usage_delta(
            None,
            Some(4.0),
            Some(&per_model(&[("opus", 10_000.0, 40.0)])),
            None,
            true,
        );
        assert!(seeded.is_empty(), "lifetime usage is not new usage");
        // A subagent starts on another model: everything it reports is new.
        let later = usage_delta(
            None,
            None,
            Some(&per_model(&[
                ("opus", 10_050.0, 41.0),
                ("haiku", 70.0, 2.0),
            ])),
            Some(&seeded.observation),
            true,
        );
        assert_eq!(
            later.models,
            BTreeMap::from([
                ("haiku".to_string(), moved(70.0, 2.0)),
                ("opus".to_string(), moved(50.0, 1.0)),
            ])
        );
    }

    #[test]
    fn a_session_an_older_build_counted_as_one_sum_starts_its_models_as_a_base() {
        let old = observation(&[(Input, 10_000.0)], Some(4.0));
        let first = usage_delta(
            Some(&tokens(&[(Input, 10_020.0)])),
            Some(4.5),
            Some(&per_model(&[
                ("opus", 9_000.0, 30.0),
                ("haiku", 1_020.0, 9.0),
            ])),
            Some(&old),
            false,
        );
        assert!(
            first.models.is_empty(),
            "those tokens are in the ledger already"
        );
        assert_eq!(
            first.tokens,
            tokens(&[(Input, 20.0)]),
            "what the models gained past the older build's sum is booked once"
        );
        assert_eq!(first.cost, DeltaCost::Provider(0.5), "the cost carries on");
        let next = usage_delta(
            None,
            None,
            Some(&per_model(&[
                ("opus", 9_100.0, 31.0),
                ("haiku", 1_020.0, 9.0),
            ])),
            Some(&first.observation),
            false,
        );
        assert_eq!(
            next.models,
            BTreeMap::from([("opus".to_string(), moved(100.0, 1.0))])
        );
    }

    #[test]
    fn a_models_recount_dip_books_nothing_and_its_neighbour_still_counts() {
        let first = usage_delta(
            None,
            None,
            Some(&per_model(&[
                ("opus", 1_000_000.0, 50.0),
                ("haiku", 10.0, 1.0),
            ])),
            None,
            false,
        );
        let next = usage_delta(
            None,
            None,
            Some(&per_model(&[
                ("opus", 999_000.0, 50.0),
                ("haiku", 15.0, 2.0),
            ])),
            Some(&first.observation),
            false,
        );
        assert_eq!(
            next.models,
            BTreeMap::from([("haiku".to_string(), moved(5.0, 1.0))])
        );
        assert_eq!(
            next.observation.models["opus"].total_tokens.input,
            Some(1_000_000.0),
            "the high-water mark stays"
        );
    }
}
