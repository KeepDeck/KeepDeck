//! Where prices come from: the models.dev catalogue, live and historical.
//!
//! Two sources speak two shapes, and each has one adapter here into the
//! canonical [`PriceRow`]:
//! - the live catalogue, `https://models.dev/api.json` — current prices only,
//!   fetched by the host and handed to [`parse_api`];
//! - the seed shipped with the app, `resources/pricing/model-prices.seed.json`
//!   — the price HISTORY, built once from the models.dev repository's git
//!   history by `scripts/price-history.mjs`, read by [`parse_seed`].
//!
//! Only model MAKERS are recorded ([`makers`]): the metric is what the usage
//! would have cost at the maker's own API, and a reseller's price — the
//! cheapest host of an open-weight model, say — is a different number.
//!
//! [`changes`] turns a fresh catalogue into the rows the journal is missing:
//! a row is appended only when a model's price actually moved.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

use crate::pricing::{Journal, Price, PriceRow, Rates, Tier};

/// The makers list both this crate and the seed builder read — one copy.
const MAKERS_JSON: &str = include_str!("../../../resources/pricing/makers.json");

/// The seed format this build reads.
pub const SEED_VERSION: u64 = 1;

/// The models.dev providers that make models and publish their own list
/// price, in resolve preference order.
pub fn makers() -> &'static [String] {
    static MAKERS: OnceLock<Vec<String>> = OnceLock::new();
    MAKERS.get_or_init(|| {
        #[derive(Deserialize)]
        struct File {
            makers: Vec<String>,
        }
        serde_json::from_str::<File>(MAKERS_JSON)
            .expect("resources/pricing/makers.json is a makers list")
            .makers
    })
}

/// One maker model as the live catalogue lists it now.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogueEntry {
    pub model: String,
    pub name: Option<String>,
    pub price: Price,
}

/// The maker models in a models.dev `api.json` body. A model without both an
/// input and an output price is skipped — an unpriced model is absent, not
/// free. `api.json` states one cache-write rate, the 5-minute one; it has no
/// 1-hour rate (see [`changes`] for how that gap is carried).
pub fn parse_api(body: &str) -> Result<Vec<CatalogueEntry>, String> {
    let root: Value = serde_json::from_str(body).map_err(|e| format!("catalogue is not JSON: {e}"))?;
    let providers = root.as_object().ok_or("catalogue is not an object of providers")?;
    let mut entries = Vec::new();
    for maker in makers() {
        let Some(models) = providers.get(maker).and_then(|p| p.get("models")).and_then(Value::as_object) else {
            continue;
        };
        for (id, model) in models {
            let Some(price) = model.get("cost").and_then(api_price) else {
                continue;
            };
            let mut price = price;
            if let Some(modes) = model.pointer("/experimental/modes").and_then(Value::as_object) {
                for (mode, spec) in modes {
                    if let Some(rates) = spec.get("cost").and_then(api_rates) {
                        price.modes.insert(mode.clone(), rates);
                    }
                }
            }
            entries.push(CatalogueEntry {
                model: format!("{maker}/{id}"),
                name: model.get("name").and_then(Value::as_str).map(str::to_owned),
                price,
            });
        }
    }
    Ok(entries)
}

/// `{input, output, cache_read?, cache_write?}` → rates; None without both
/// input and output.
fn api_rates(cost: &Value) -> Option<Rates> {
    let number = |key: &str| cost.get(key).and_then(Value::as_f64).filter(|v| v.is_finite() && *v >= 0.0);
    Some(Rates {
        input: number("input")?,
        output: number("output")?,
        cache_read: number("cache_read"),
        cache_write: number("cache_write"),
        cache_write_1h: None,
    })
}

/// A model's `cost`: base rates plus its context tiers. Only `tiers` is read;
/// `context_over_200k` is the catalogue's deprecated single-tier copy and can
/// name a threshold the tier itself does not use.
fn api_price(cost: &Value) -> Option<Price> {
    let rates = api_rates(cost)?;
    let mut tiers = Vec::new();
    for tier in cost.get("tiers").and_then(Value::as_array).into_iter().flatten() {
        let context = tier.get("tier").filter(|t| t.get("type").and_then(Value::as_str) == Some("context"));
        let Some(over) = context.and_then(|t| t.get("size")).and_then(Value::as_u64) else {
            continue;
        };
        if let Some(rates) = api_rates(tier) {
            tiers.push(Tier { over, rates });
        }
    }
    tiers.sort_by_key(|tier| tier.over);
    Some(Price {
        rates,
        tiers,
        modes: BTreeMap::new(),
    })
}

/// The rows a fresh catalogue adds to `journal`, all starting at `at` (unix
/// ms) — the moment the change was seen.
///
/// A row is added only when a model's price differs from its newest row, so
/// a daily fetch of an unchanged catalogue adds nothing. A rate the live
/// catalogue cannot state (the 1-hour cache write) is carried over from the
/// newest row rather than read as removed — otherwise every fetch would
/// "change" a price the seed knows in full.
pub fn changes(journal: &Journal, entries: &[CatalogueEntry], at: f64) -> Vec<PriceRow> {
    let mut rows = Vec::new();
    for entry in entries {
        let latest = journal.latest(&entry.model);
        let price = match latest {
            Some(row) => carried(&entry.price, &row.price),
            None => entry.price.clone(),
        };
        if latest.is_some_and(|row| row.price == price) {
            continue;
        }
        rows.push(PriceRow {
            model: entry.model.clone(),
            from: at,
            name: entry.name.clone(),
            price,
        });
    }
    rows
}

/// `fresh` with the 1-hour rates it cannot state taken from `known` — base,
/// per tier (matched by threshold) and per mode.
fn carried(fresh: &Price, known: &Price) -> Price {
    let carry = |fresh: &Rates, known: Option<&Rates>| Rates {
        cache_write_1h: fresh.cache_write_1h.or(known.and_then(|k| k.cache_write_1h)),
        ..fresh.clone()
    };
    Price {
        rates: carry(&fresh.rates, Some(&known.rates)),
        tiers: fresh
            .tiers
            .iter()
            .map(|tier| Tier {
                over: tier.over,
                rates: carry(
                    &tier.rates,
                    known.tiers.iter().find(|k| k.over == tier.over).map(|k| &k.rates),
                ),
            })
            .collect(),
        modes: fresh
            .modes
            .iter()
            .map(|(mode, rates)| (mode.clone(), carry(rates, known.modes.get(mode))))
            .collect(),
    }
}

/// The price rows in a seed file. A seed from a newer format is refused
/// rather than half-read.
pub fn parse_seed(body: &str) -> Result<Vec<PriceRow>, String> {
    #[derive(Deserialize)]
    struct Seed {
        version: u64,
        models: HashMap<String, Vec<SeedEntry>>,
    }
    #[derive(Deserialize)]
    struct SeedEntry {
        from: f64,
        #[serde(default)]
        name: Option<String>,
        #[serde(flatten)]
        price: Price,
    }
    let seed: Seed = serde_json::from_str(body).map_err(|e| format!("price seed is unreadable: {e}"))?;
    if seed.version != SEED_VERSION {
        return Err(format!(
            "price seed is version {}, this build reads {SEED_VERSION}",
            seed.version
        ));
    }
    let mut rows: Vec<PriceRow> = seed
        .models
        .into_iter()
        .flat_map(|(model, entries)| {
            entries.into_iter().map(move |entry| PriceRow {
                model: model.clone(),
                from: entry.from,
                name: entry.name,
                price: entry.price,
            })
        })
        .collect();
    rows.sort_by(|a, b| a.model.cmp(&b.model).then(a.from.total_cmp(&b.from)));
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal(rows: Vec<PriceRow>) -> Journal {
        Journal::new(rows, makers().to_vec())
    }

    const API: &str = r#"{
      "anthropic": { "models": {
        "claude-opus-5-5": { "name": "Claude Opus 5.5",
          "cost": { "input": 4, "output": 20, "cache_read": 0.2, "cache_write": 5 },
          "experimental": { "modes": {
            "fast": { "cost": { "input": 8, "output": 40, "cache_read": 0.4, "cache_write": 10 } },
            "pro": { "provider": {} } } } },
        "claude-free": { "name": "No price", "cost": { "input": 1 } }
      } },
      "openai": { "models": {
        "gpt-6.1-sol": { "name": "GPT-6.1 Sol",
          "cost": { "input": 2, "output": 10, "cache_read": 0.1, "cache_write": 2.5,
            "tiers": [ { "input": 4, "output": 15, "cache_read": 0.2, "cache_write": 5,
                         "tier": { "type": "context", "size": 272000 } } ],
            "context_over_200k": { "input": 4, "output": 15 } } }
      } },
      "openrouter": { "models": {
        "glm-5.3": { "name": "GLM via a reseller", "cost": { "input": 0.07, "output": 1.4 } }
      } }
    }"#;

    fn entry<'a>(entries: &'a [CatalogueEntry], model: &str) -> &'a CatalogueEntry {
        entries.iter().find(|e| e.model == model).expect(model)
    }

    #[test]
    fn makers_are_read_from_the_shared_list_in_order() {
        let makers = makers();
        assert_eq!(makers.first().map(String::as_str), Some("anthropic"));
        let zai = makers.iter().position(|m| m == "zai").unwrap();
        let zhipuai = makers.iter().position(|m| m == "zhipuai").unwrap();
        assert!(zai < zhipuai, "the international list price is preferred");
    }

    #[test]
    fn only_makers_enter_the_catalogue() {
        let entries = parse_api(API).unwrap();
        assert!(entries.iter().all(|e| !e.model.starts_with("openrouter/")));
    }

    #[test]
    fn a_model_without_input_and_output_is_absent_not_free() {
        let entries = parse_api(API).unwrap();
        assert!(entries.iter().all(|e| e.model != "anthropic/claude-free"));
    }

    #[test]
    fn rates_modes_and_names_are_read() {
        let entries = parse_api(API).unwrap();
        let opus = entry(&entries, "anthropic/claude-opus-5-5");
        assert_eq!(opus.name.as_deref(), Some("Claude Opus 5.5"));
        assert_eq!(opus.price.rates.input, 4.0);
        assert_eq!(opus.price.rates.cache_write, Some(5.0));
        assert_eq!(opus.price.rates.cache_write_1h, None);
        assert_eq!(opus.price.modes.get("fast").map(|r| r.output), Some(40.0));
        assert!(!opus.price.modes.contains_key("pro"), "a mode with no cost is not a price");
    }

    #[test]
    fn tiers_come_from_tiers_and_never_from_the_deprecated_copy() {
        let entries = parse_api(API).unwrap();
        let sol = entry(&entries, "openai/gpt-6.1-sol");
        assert_eq!(sol.price.tiers.len(), 1);
        assert_eq!(sol.price.tiers[0].over, 272_000);
        assert_eq!(sol.price.tiers[0].rates.output, 15.0);
    }

    #[test]
    fn an_unchanged_catalogue_adds_no_rows() {
        let entries = parse_api(API).unwrap();
        let first = changes(&journal(vec![]), &entries, 1.0);
        assert_eq!(first.len(), entries.len());
        let again = changes(&journal(first), &entries, 2.0);
        assert!(again.is_empty(), "{again:?}");
    }

    #[test]
    fn a_moved_price_adds_a_row_from_the_moment_it_was_seen() {
        let entries = parse_api(API).unwrap();
        let known = changes(&journal(vec![]), &entries, 1.0);
        let mut moved = entries.clone();
        moved.iter_mut().find(|e| e.model == "openai/gpt-6.1-sol").unwrap().price.rates.output = 12.0;
        let rows = changes(&journal(known), &moved, 5.0);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].model, "openai/gpt-6.1-sol");
        assert_eq!(rows[0].from, 5.0);
        assert_eq!(rows[0].price.rates.output, 12.0);
    }

    #[test]
    fn a_one_hour_rate_the_live_catalogue_cannot_state_is_carried_not_removed() {
        let entries = parse_api(API).unwrap();
        let mut seeded = changes(&journal(vec![]), &entries, 1.0);
        let opus = seeded.iter_mut().find(|r| r.model == "anthropic/claude-opus-5-5").unwrap();
        opus.price.rates.cache_write_1h = Some(8.0);
        opus.price.modes.get_mut("fast").unwrap().cache_write_1h = Some(16.0);
        let rows = changes(&journal(seeded), &entries, 2.0);
        assert!(rows.is_empty(), "the live catalogue's silence is not a change: {rows:?}");

        let mut moved = entries.clone();
        moved.iter_mut().find(|e| e.model == "anthropic/claude-opus-5-5").unwrap().price.rates.input = 3.0;
        let mut seeded = changes(&journal(vec![]), &entries, 1.0);
        seeded.iter_mut().find(|r| r.model == "anthropic/claude-opus-5-5").unwrap().price.rates.cache_write_1h = Some(8.0);
        let rows = changes(&journal(seeded), &moved, 3.0);
        assert_eq!(rows[0].price.rates.cache_write_1h, Some(8.0));
        assert_eq!(rows[0].price.rates.input, 3.0);
    }

    #[test]
    fn a_seed_reads_into_rows_per_model_oldest_first() {
        let seed = r#"{ "version": 1, "source": "anomalyco/models.dev", "commit": "abc",
          "models": {
            "zai/glm-5.3": [
              { "from": 20, "name": "GLM-5.3", "input": 1.4, "output": 4.4, "cacheRead": 0.26, "cacheWrite": null, "cacheWrite1h": null, "tiers": [], "modes": {} },
              { "from": 10, "name": "GLM-5.3", "input": 1.5, "output": 4.4, "cacheRead": 0.26, "cacheWrite": null, "cacheWrite1h": null, "tiers": [], "modes": {} }
            ],
            "anthropic/claude-opus-5-5": [
              { "from": 5, "name": "Claude Opus 5.5", "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5, "cacheWrite1h": 8,
                "tiers": [ { "over": 272000, "input": 8, "output": 30, "cacheRead": null, "cacheWrite": null, "cacheWrite1h": null } ],
                "modes": { "fast": { "input": 8, "output": 40, "cacheRead": 0.4, "cacheWrite": 10, "cacheWrite1h": 16 } } }
            ]
          } }"#;
        let rows = parse_seed(seed).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].model, "anthropic/claude-opus-5-5");
        assert_eq!(rows[0].price.rates.cache_write_1h, Some(8.0));
        assert_eq!(rows[0].price.tiers[0].over, 272_000);
        assert_eq!(rows[0].price.modes["fast"].cache_write_1h, Some(16.0));
        assert_eq!((rows[1].from, rows[2].from), (10.0, 20.0));
        assert_eq!(rows[1].price.rates.cache_write, None);
    }

    #[test]
    fn a_seed_of_another_version_is_refused() {
        let err = parse_seed(r#"{ "version": 2, "models": {} }"#).unwrap_err();
        assert!(err.contains("version 2"), "{err}");
    }
}
