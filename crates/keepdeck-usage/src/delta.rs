//! Cumulative report → durable delta. The one place that knows how a
//! provider's growing counters become the non-negative increments the
//! ledger stores: the reset rule, the noise rule and the resumed-session
//! rule.

use crate::model::{Observation, TokenCounts, TOKEN_KINDS};

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

#[derive(Debug, Clone, PartialEq)]
pub struct Delta {
    pub tokens: TokenCounts,
    pub cost: DeltaCost,
    /// The base the next report is measured against.
    pub observation: Observation,
}

impl Delta {
    /// Nothing to book: no counter moved and nothing was priced.
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty() && self.cost == DeltaCost::Unavailable
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

/// Convert a cumulative report into a non-negative delta against `previous`.
///
/// `baseline_only` seeds each dimension of a resumed session that has no
/// base yet: its lifetime counters and cost become the base and nothing is
/// booked for them. Tokens and cost may arrive in separate reports, so each
/// dimension seeds on its own.
pub fn usage_delta(
    total_tokens: Option<&TokenCounts>,
    cost_usd: Option<f64>,
    previous: Option<&Observation>,
    baseline_only: bool,
) -> Delta {
    let mut observed_tokens = previous.map(|p| p.tokens.clone()).unwrap_or_default();
    let mut delta_tokens = TokenCounts::default();

    let previous_cost = finite_non_negative(previous.and_then(|p| p.cost_usd));
    let mut observed_cost = previous.and_then(|p| p.cost_usd);
    let mut cost = DeltaCost::Unavailable;
    if let Some(current) = finite_non_negative(cost_usd) {
        let seed = baseline_only && previous_cost.is_none();
        let (booked, base) = movement(current, previous_cost);
        if !seed {
            // A base with no movement books nothing; a first price books
            // even zero — an explicit "this cost nothing" is a priced event.
            if let Some(booked) = booked {
                if previous_cost.is_none() || booked > 0.0 {
                    cost = DeltaCost::Provider(round_money(booked));
                }
            }
        }
        observed_cost = Some(base);
    }

    if let Some(current) = total_tokens {
        for kind in TOKEN_KINDS {
            let Some(value) = finite_non_negative(current.get(kind)) else {
                continue;
            };
            let before = finite_non_negative(previous.and_then(|p| p.tokens.get(kind)));
            let seed = baseline_only && before.is_none();
            let (booked, base) = movement(value, before);
            observed_tokens.set(kind, Some(base));
            if !seed {
                if let Some(booked) = booked.filter(|b| *b > 0.0) {
                    delta_tokens.set(kind, Some(booked));
                }
            }
        }
    }

    Delta {
        tokens: delta_tokens,
        cost,
        observation: Observation {
            tokens: observed_tokens,
            cost_usd: observed_cost,
        },
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
        }
    }

    use crate::model::TokenKind::{CacheRead, Input, Output};

    #[test]
    fn turns_cumulative_token_and_cost_snapshots_into_deltas() {
        let delta = usage_delta(
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
        let delta = usage_delta(
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
        let delta = usage_delta(
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
        let dip = usage_delta(
            Some(&tokens(&[(CacheRead, 2_924_095_591.0)])),
            None,
            Some(&base),
            false,
        );
        assert!(dip.is_empty(), "a recount is not usage");
        assert_eq!(dip.observation.tokens.cache_read, Some(2_924_098_014.0));

        // Growth is booked from the high-water mark, never from the dip.
        let grown = usage_delta(
            Some(&tokens(&[(CacheRead, 2_924_100_000.0)])),
            None,
            Some(&dip.observation),
            false,
        );
        assert_eq!(grown.tokens, tokens(&[(CacheRead, 1_986.0)]));
    }

    #[test]
    fn a_small_cost_dip_prices_nothing_and_keeps_the_high_water_mark() {
        let dip = usage_delta(None, Some(9.9), Some(&observation(&[], Some(10.0))), false);
        assert_eq!(dip.cost, DeltaCost::Unavailable);
        assert_eq!(dip.observation.cost_usd, Some(10.0));
    }

    #[test]
    fn recognizes_duplicate_cumulative_observations() {
        let delta = usage_delta(
            Some(&tokens(&[(Input, 10.0)])),
            Some(1.0),
            Some(&observation(&[(Input, 10.0)], Some(1.0))),
            false,
        );
        assert!(delta.is_empty());
    }

    #[test]
    fn seeds_a_resumed_session_without_backfilling_lifetime_usage() {
        let delta = usage_delta(
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
        let cost = usage_delta(None, Some(9.0), None, true);
        assert!(cost.is_empty());
        assert_eq!(cost.observation, observation(&[], Some(9.0)));

        let counted = usage_delta(
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

        let later = usage_delta(
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
        let first = usage_delta(None, Some(0.0), None, false);
        assert_eq!(first.cost, DeltaCost::Provider(0.0));
        assert!(!first.is_empty());
        assert!(usage_delta(None, Some(0.0), Some(&observation(&[], Some(0.0))), false).is_empty());
    }
}
