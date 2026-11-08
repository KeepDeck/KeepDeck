//! What usage costs: its tokens × the model maker's list price in effect
//! when the call happened.
//!
//! The ONE place a price is applied. The ledger stores tokens and never
//! money, and every reader gets its money from here at read time — so a
//! catalogue correction, or a model the catalogue learns late, re-prices the
//! past without a migration, and no second formula can drift from this one.
//!
//! Prices are USD per million tokens, as the catalogue (models.dev) states
//! them. A price is a [`Price`]: base rates, the long-context [`Tier`]s that
//! replace them past a prompt size, and the service-tier modes (claude's
//! fast mode, OpenAI's priority) that replace them for a call made in that
//! mode. A model's prices over time are its [`PriceRow`]s; the
//! [`Journal`] holds them all and answers "what did this cost".

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::model::TokenCounts;

/// Catalogue prices are per this many tokens.
pub const PER_TOKENS: f64 = 1_000_000.0;

/// Anthropic bills a cache write held for one hour at twice the model's base
/// input price (its published rule; the 5-minute write is 1.25×). The live
/// catalogue states only the 5-minute rate, so a row learned from it leans on
/// this — and only Anthropic models write 1-hour caches at all.
pub const ONE_HOUR_WRITE_FACTOR: f64 = 2.0;

/// One set of per-class rates, USD per million tokens. `input` and `output`
/// are always known; a cache rate the catalogue does not state is `None`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_read: Option<f64>,
    #[serde(default)]
    pub cache_write: Option<f64>,
    #[serde(default, rename = "cacheWrite1h")]
    pub cache_write_1h: Option<f64>,
}

/// Rates that replace the base ones for a call whose prompt is larger than
/// `over` tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier {
    pub over: u64,
    #[serde(flatten)]
    pub rates: Rates,
}

/// A model's whole price at one moment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    #[serde(flatten)]
    pub rates: Rates,
    #[serde(default)]
    pub tiers: Vec<Tier>,
    /// By the catalogue's mode name ("fast", "ultrafast") — the name a call
    /// records as its mode.
    #[serde(default)]
    pub modes: BTreeMap<String, Rates>,
}

/// A model's price from `from` (unix ms) until its next row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRow {
    /// The maker's key: `<maker provider>/<model id>`.
    pub model: String,
    pub from: f64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(flatten)]
    pub price: Price,
}

/// How much a priced figure can be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CostBasis {
    /// The maker's list price in effect at the time, every class stated.
    Estimated,
    /// Priced, but by a stand-in somewhere: the earliest known price for usage
    /// older than it, base rates for a mode or tier the row does not carry, or
    /// the input rate for a cache class the catalogue does not price.
    Approximate,
    /// No price known for this model: shown as "—", never as $0.
    Unpriced,
}

/// One priced figure: its cost (absent when unpriced), how far to trust it,
/// and the model's display name when the catalogue knows the model.
#[derive(Debug, Clone, PartialEq)]
pub struct Priced {
    pub cost_usd: Option<f64>,
    pub basis: CostBasis,
    pub name: Option<String>,
}

/// What to price: tokens a model spent at `at` (unix ms), in `mode` (empty
/// for the standard service tier) and past the long-context threshold `tier`
/// (0 below every threshold). `model` is the key as the usage was booked —
/// `<provider>/<model>`, the provider being whoever the agent said served it.
#[derive(Debug, Clone, Copy)]
pub struct Usage<'a> {
    pub model: &'a str,
    pub mode: &'a str,
    pub tier: u64,
    pub at: f64,
    pub tokens: &'a TokenCounts,
}

/// Every known price, by maker key, oldest first.
#[derive(Debug, Clone, Default)]
pub struct Journal {
    rows: HashMap<String, Vec<PriceRow>>,
    makers: Vec<String>,
}

impl Journal {
    /// `makers` in resolve preference order — see [`crate::catalogue::makers`].
    pub fn new(rows: impl IntoIterator<Item = PriceRow>, makers: Vec<String>) -> Self {
        let mut by_model: HashMap<String, Vec<PriceRow>> = HashMap::new();
        for row in rows {
            by_model.entry(row.model.clone()).or_default().push(row);
        }
        for rows in by_model.values_mut() {
            rows.sort_by(|a, b| a.from.total_cmp(&b.from));
        }
        Self { rows: by_model, makers }
    }

    /// The newest row of each model — what a fresh catalogue is compared to.
    pub fn latest(&self, model: &str) -> Option<&PriceRow> {
        self.rows.get(model).and_then(|rows| rows.last())
    }

    /// The maker key a booked model is priced under, or None when no maker
    /// lists it.
    ///
    /// A booked key names whoever SERVED the call: claude's is the maker
    /// already (`anthropic/claude-opus-5-5`), but opencode books its own
    /// provider (`zai-coding-plan/glm-5.3`, `openrouter/x-ai/grok-4.6`). The
    /// list price is the maker's: a maker provider is priced from its own
    /// list, and a non-maker provider resolves by the model id among the
    /// makers, in preference order. The id is never rewritten into a
    /// "similar" model, nor priced at another maker's rate: an id its maker
    /// does not list, or no maker lists, is unpriced.
    pub fn resolve(&self, booked: &str) -> Option<&str> {
        let (provider, model) = booked.split_once('/')?;
        let mut ids = vec![model];
        if let Some((_, last)) = model.rsplit_once('/') {
            ids.push(last);
        }
        let makers = match self.makers.iter().position(|maker| maker == provider) {
            Some(own) => &self.makers[own..=own],
            None => &self.makers[..],
        };
        ids.into_iter().find_map(|id| {
            makers
                .iter()
                .find_map(|maker| self.rows.get_key_value(&format!("{maker}/{id}")))
                .map(|(key, _)| key.as_str())
        })
    }

    /// The row in effect at `at`, and whether `at` predates every row (the
    /// earliest row then stands in for it).
    fn row_at(&self, key: &str, at: f64) -> Option<(&PriceRow, bool)> {
        let rows = self.rows.get(key)?;
        let first = rows.first()?;
        if at < first.from {
            return Some((first, true));
        }
        rows.iter().rev().find(|row| row.from <= at).map(|row| (row, false))
    }

    /// The long-context threshold a call with `prompt` tokens crossed, by the
    /// price in effect at `at` — 0 when it crossed none, or the model is
    /// unknown. Decided when the call is booked: a bucket of summed calls no
    /// longer knows any one call's prompt.
    pub fn tier_of(&self, booked: &str, at: f64, prompt: f64) -> u64 {
        let Some(key) = self.resolve(booked) else {
            return 0;
        };
        let Some((row, _)) = self.row_at(key, at) else {
            return 0;
        };
        row.price
            .tiers
            .iter()
            .filter(|tier| prompt > tier.over as f64)
            .map(|tier| tier.over)
            .max()
            .unwrap_or(0)
    }

    /// What `usage` cost.
    pub fn price(&self, usage: Usage<'_>) -> Priced {
        let Some(key) = self.resolve(usage.model) else {
            return unpriced();
        };
        let Some((row, before_first)) = self.row_at(key, usage.at) else {
            return unpriced();
        };
        let (rates, stood_in) = rates_for(&row.price, usage.mode, usage.tier);
        let (cost, class_stood_in) = cost_of(usage.tokens, &rates);
        let approximate = before_first || stood_in || class_stood_in;
        Priced {
            cost_usd: Some(cost),
            basis: if approximate {
                CostBasis::Approximate
            } else {
                CostBasis::Estimated
            },
            name: row.name.clone(),
        }
    }
}

fn unpriced() -> Priced {
    Priced {
        cost_usd: None,
        basis: CostBasis::Unpriced,
        name: None,
    }
}

/// The rates a call in `mode` past `tier` pays, and whether a stand-in was
/// needed: a tier or mode the price does not carry falls back to the base
/// rates. A mode past a tier pays the tier's rates scaled by the mode's
/// factor over the base input — the catalogue states a mode's rates for the
/// base tier only.
fn rates_for(price: &Price, mode: &str, tier: u64) -> (Rates, bool) {
    let tiered = if tier == 0 {
        Some(&price.rates)
    } else {
        price.tiers.iter().find(|t| t.over == tier).map(|t| &t.rates)
    };
    let (rates, mut stood_in) = match tiered {
        Some(rates) => (rates.clone(), false),
        None => (price.rates.clone(), true),
    };
    if mode.is_empty() {
        return (rates, stood_in);
    }
    let Some(moded) = price.modes.get(mode) else {
        return (rates, true);
    };
    if tier == 0 || stood_in {
        return (moded.clone(), stood_in);
    }
    if price.rates.input <= 0.0 {
        stood_in = true;
        return (rates, stood_in);
    }
    (scaled(&rates, moded.input / price.rates.input), stood_in)
}

fn scaled(rates: &Rates, factor: f64) -> Rates {
    Rates {
        input: rates.input * factor,
        output: rates.output * factor,
        cache_read: rates.cache_read.map(|rate| rate * factor),
        cache_write: rates.cache_write.map(|rate| rate * factor),
        cache_write_1h: rates.cache_write_1h.map(|rate| rate * factor),
    }
}

/// Tokens × rates, and whether a class the tokens use had no stated rate.
///
/// The classes are the canonical ones every agent's usage is mapped into
/// before it is booked: `input` is fresh input only, `output` is everything
/// billed as output (reasoning included — `reasoning` is a share of it, shown
/// and never priced again). A cache class the catalogue does not price is
/// billed at the input rate, never at zero; the 1-hour write falls back to
/// Anthropic's rule.
fn cost_of(tokens: &TokenCounts, rates: &Rates) -> (f64, bool) {
    let mut stood_in = false;
    let mut class = |count: Option<f64>, rate: Option<f64>, fallback: f64, flags: bool| {
        let count = count.unwrap_or(0.0);
        if count <= 0.0 {
            return 0.0;
        }
        count
            * rate.unwrap_or_else(|| {
                stood_in |= flags;
                fallback
            })
    };
    let total = tokens.input.unwrap_or(0.0).max(0.0) * rates.input
        + tokens.output.unwrap_or(0.0).max(0.0) * rates.output
        + class(tokens.cache_read, rates.cache_read, rates.input, true)
        + class(tokens.cache_write, rates.cache_write, rates.input, true)
        + class(
            tokens.cache_write_1h,
            rates.cache_write_1h,
            rates.input * ONE_HOUR_WRITE_FACTOR,
            false,
        );
    (total / PER_TOKENS, stood_in)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: f64 = 86_400_000.0;

    fn rates(input: f64, output: f64, read: f64, write: f64) -> Rates {
        Rates {
            input,
            output,
            cache_read: Some(read),
            cache_write: Some(write),
            cache_write_1h: None,
        }
    }

    fn row(model: &str, from: f64, price: Price) -> PriceRow {
        PriceRow {
            model: model.into(),
            from,
            name: Some(format!("name of {model}")),
            price,
        }
    }

    fn plain(rates: Rates) -> Price {
        Price {
            rates,
            tiers: Vec::new(),
            modes: BTreeMap::new(),
        }
    }

    fn journal(rows: Vec<PriceRow>) -> Journal {
        Journal::new(rows, vec!["zai".into(), "zhipuai".into(), "anthropic".into(), "openai".into()])
    }

    fn tokens(input: f64, output: f64, read: f64, write: f64, write_1h: f64) -> TokenCounts {
        TokenCounts {
            input: Some(input),
            output: Some(output),
            cache_read: Some(read),
            cache_write: Some(write),
            cache_write_1h: Some(write_1h),
            ..TokenCounts::default()
        }
    }

    fn usage<'a>(model: &'a str, at: f64, tokens: &'a TokenCounts) -> Usage<'a> {
        Usage { model, mode: "", tier: 0, at, tokens }
    }

    #[test]
    fn every_class_is_billed_at_its_own_rate_per_million() {
        let j = journal(vec![row("anthropic/opus", 0.0, plain(rates(4.0, 20.0, 0.2, 5.0)))]);
        let t = tokens(1_000_000.0, 1_000_000.0, 1_000_000.0, 1_000_000.0, 0.0);
        let priced = j.price(usage("anthropic/opus", DAY, &t));
        assert_eq!(priced.cost_usd, Some(4.0 + 20.0 + 0.2 + 5.0));
        assert_eq!(priced.basis, CostBasis::Estimated);
        assert_eq!(priced.name.as_deref(), Some("name of anthropic/opus"));
    }

    #[test]
    fn a_one_hour_write_without_a_rate_is_twice_the_input_and_stays_estimated() {
        let j = journal(vec![row("anthropic/opus", 0.0, plain(rates(4.0, 20.0, 0.2, 5.0)))]);
        let t = tokens(0.0, 0.0, 0.0, 0.0, 1_000_000.0);
        let priced = j.price(usage("anthropic/opus", DAY, &t));
        assert_eq!(priced.cost_usd, Some(8.0));
        assert_eq!(priced.basis, CostBasis::Estimated);
    }

    #[test]
    fn a_stated_one_hour_rate_wins_over_the_rule() {
        let mut r = rates(4.0, 20.0, 0.2, 5.0);
        r.cache_write_1h = Some(9.0);
        let j = journal(vec![row("anthropic/opus", 0.0, plain(r))]);
        let t = tokens(0.0, 0.0, 0.0, 0.0, 1_000_000.0);
        assert_eq!(j.price(usage("anthropic/opus", DAY, &t)).cost_usd, Some(9.0));
    }

    #[test]
    fn an_unpriced_cache_class_bills_at_the_input_rate_and_is_approximate() {
        let mut r = rates(1.4, 4.4, 0.26, 0.0);
        r.cache_write = None;
        let j = journal(vec![row("zai/glm", 0.0, plain(r))]);
        let t = tokens(0.0, 0.0, 0.0, 1_000_000.0, 0.0);
        let priced = j.price(usage("zai/glm", DAY, &t));
        assert_eq!(priced.cost_usd, Some(1.4));
        assert_eq!(priced.basis, CostBasis::Approximate);
    }

    #[test]
    fn an_unpriced_class_with_no_tokens_does_not_make_the_figure_approximate() {
        let mut r = rates(1.4, 4.4, 0.26, 0.0);
        r.cache_write = None;
        let j = journal(vec![row("zai/glm", 0.0, plain(r))]);
        let t = tokens(1_000_000.0, 0.0, 0.0, 0.0, 0.0);
        assert_eq!(j.price(usage("zai/glm", DAY, &t)).basis, CostBasis::Estimated);
    }

    #[test]
    fn the_price_in_effect_at_the_time_applies_not_the_newest() {
        let j = journal(vec![
            row("anthropic/opus", 0.0, plain(rates(5.0, 25.0, 0.5, 6.25))),
            row("anthropic/opus", 10.0 * DAY, plain(rates(4.0, 20.0, 0.2, 5.0))),
        ]);
        let t = tokens(1_000_000.0, 0.0, 0.0, 0.0, 0.0);
        assert_eq!(j.price(usage("anthropic/opus", 5.0 * DAY, &t)).cost_usd, Some(5.0));
        assert_eq!(j.price(usage("anthropic/opus", 10.0 * DAY, &t)).cost_usd, Some(4.0));
        assert_eq!(j.price(usage("anthropic/opus", 20.0 * DAY, &t)).cost_usd, Some(4.0));
    }

    #[test]
    fn usage_older_than_every_price_takes_the_earliest_and_is_approximate() {
        let j = journal(vec![row("anthropic/opus", 10.0 * DAY, plain(rates(4.0, 20.0, 0.2, 5.0)))]);
        let t = tokens(1_000_000.0, 0.0, 0.0, 0.0, 0.0);
        let priced = j.price(usage("anthropic/opus", DAY, &t));
        assert_eq!(priced.cost_usd, Some(4.0));
        assert_eq!(priced.basis, CostBasis::Approximate);
    }

    #[test]
    fn an_unknown_model_is_unpriced_not_free() {
        let j = journal(vec![row("anthropic/opus", 0.0, plain(rates(4.0, 20.0, 0.2, 5.0)))]);
        let t = tokens(1_000_000.0, 0.0, 0.0, 0.0, 0.0);
        let priced = j.price(usage("kimi-code/kimi-for-coding", DAY, &t));
        assert_eq!(priced.cost_usd, None);
        assert_eq!(priced.basis, CostBasis::Unpriced);
    }

    #[test]
    fn a_reseller_resolves_to_the_maker_by_model_id_in_preference_order() {
        let j = journal(vec![
            row("zhipuai/glm-5.3", 0.0, plain(rates(1.2, 4.2, 0.3, 0.0))),
            row("zai/glm-5.3", 0.0, plain(rates(1.4, 4.4, 0.26, 0.0))),
        ]);
        assert_eq!(j.resolve("zai-coding-plan/glm-5.3"), Some("zai/glm-5.3"));
        assert_eq!(j.resolve("zhipuai/glm-5.3"), Some("zhipuai/glm-5.3"));
        assert_eq!(j.resolve("openrouter/z-ai/glm-5.3"), Some("zai/glm-5.3"));
        assert_eq!(j.resolve("zai/glm-5.4"), None);
        assert_eq!(j.resolve("no-slash"), None);
    }

    #[test]
    fn a_maker_is_priced_from_its_own_list_only() {
        // zhipuai does not list glm-5.2; zai does. A maker that served a
        // model it does not list is not priced at another maker's rate.
        let j = journal(vec![row("zai/glm-5.2", 0.0, plain(rates(1.0, 3.0, 0.2, 0.0)))]);
        assert_eq!(j.resolve("zhipuai/glm-5.2"), None);
        assert_eq!(j.resolve("zai/glm-5.2"), Some("zai/glm-5.2"));
    }

    #[test]
    fn a_tier_replaces_the_base_rates_past_its_threshold() {
        let price = Price {
            rates: rates(2.0, 10.0, 0.1, 2.5),
            tiers: vec![Tier { over: 272_000, rates: rates(4.0, 15.0, 0.2, 5.0) }],
            modes: BTreeMap::new(),
        };
        let j = journal(vec![row("openai/sol", 0.0, price)]);
        assert_eq!(j.tier_of("openai/sol", DAY, 272_000.0), 0);
        assert_eq!(j.tier_of("openai/sol", DAY, 272_001.0), 272_000);
        assert_eq!(j.tier_of("openrouter/sol", DAY, 272_001.0), 272_000, "a reseller resolves to the maker");
        assert_eq!(j.tier_of("openai/unknown", DAY, 900_000.0), 0);
        let t = tokens(1_000_000.0, 0.0, 0.0, 0.0, 0.0);
        let priced = j.price(Usage { tier: 272_000, ..usage("openai/sol", DAY, &t) });
        assert_eq!(priced.cost_usd, Some(4.0));
        assert_eq!(priced.basis, CostBasis::Estimated);
    }

    #[test]
    fn a_tier_the_price_no_longer_carries_falls_back_to_base_approximately() {
        let j = journal(vec![row("openai/sol", 0.0, plain(rates(2.0, 10.0, 0.1, 2.5)))]);
        let t = tokens(1_000_000.0, 0.0, 0.0, 0.0, 0.0);
        let priced = j.price(Usage { tier: 272_000, ..usage("openai/sol", DAY, &t) });
        assert_eq!(priced.cost_usd, Some(2.0));
        assert_eq!(priced.basis, CostBasis::Approximate);
    }

    #[test]
    fn a_mode_pays_its_own_rates() {
        let mut price = plain(rates(4.0, 20.0, 0.2, 5.0));
        price.modes.insert("fast".into(), rates(8.0, 40.0, 0.4, 10.0));
        let j = journal(vec![row("anthropic/opus", 0.0, price)]);
        let t = tokens(1_000_000.0, 1_000_000.0, 0.0, 0.0, 0.0);
        let priced = j.price(Usage { mode: "fast", ..usage("anthropic/opus", DAY, &t) });
        assert_eq!(priced.cost_usd, Some(48.0));
        assert_eq!(priced.basis, CostBasis::Estimated);
    }

    #[test]
    fn a_mode_the_price_does_not_carry_pays_base_rates_approximately() {
        let j = journal(vec![row("anthropic/opus", 0.0, plain(rates(4.0, 20.0, 0.2, 5.0)))]);
        let t = tokens(1_000_000.0, 0.0, 0.0, 0.0, 0.0);
        let priced = j.price(Usage { mode: "fast", ..usage("anthropic/opus", DAY, &t) });
        assert_eq!(priced.cost_usd, Some(4.0));
        assert_eq!(priced.basis, CostBasis::Approximate);
    }

    #[test]
    fn a_mode_past_a_tier_scales_the_tier_by_the_modes_factor() {
        let mut price = Price {
            rates: rates(2.0, 10.0, 0.1, 2.5),
            tiers: vec![Tier { over: 272_000, rates: rates(4.0, 15.0, 0.2, 5.0) }],
            modes: BTreeMap::new(),
        };
        price.modes.insert("fast".into(), rates(4.0, 20.0, 0.2, 5.0));
        let j = journal(vec![row("openai/sol", 0.0, price)]);
        let t = tokens(1_000_000.0, 1_000_000.0, 0.0, 0.0, 0.0);
        let priced = j.price(Usage { mode: "fast", tier: 272_000, ..usage("openai/sol", DAY, &t) });
        assert_eq!(priced.cost_usd, Some(8.0 + 30.0));
        assert_eq!(priced.basis, CostBasis::Estimated);
    }

    #[test]
    fn rows_arriving_out_of_order_are_sorted_by_time() {
        let j = journal(vec![
            row("anthropic/opus", 10.0 * DAY, plain(rates(4.0, 20.0, 0.2, 5.0))),
            row("anthropic/opus", 0.0, plain(rates(5.0, 25.0, 0.5, 6.25))),
        ]);
        assert_eq!(j.latest("anthropic/opus").map(|r| r.from), Some(10.0 * DAY));
    }
}
