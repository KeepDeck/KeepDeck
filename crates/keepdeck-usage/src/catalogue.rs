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

/// The price history this build ships, built by `scripts/price-history.mjs`.
const SEED_JSON: &str = include_str!("../../../resources/pricing/model-prices.seed.json");

/// The price history this build ships.
pub fn seed() -> Result<SeedHistory, String> {
    parse_seed(SEED_JSON)
}

#[derive(Deserialize)]
struct MakersFile {
    makers: Vec<String>,
    #[serde(default)]
    labs: HashMap<String, String>,
}

fn makers_file() -> &'static MakersFile {
    static FILE: OnceLock<MakersFile> = OnceLock::new();
    FILE.get_or_init(|| serde_json::from_str(MAKERS_JSON).expect("resources/pricing/makers.json is a makers list"))
}

/// The models.dev providers that make models and publish their own list
/// price, in resolve preference order.
pub fn makers() -> &'static [String] {
    &makers_file().makers
}

/// The aliases this crate reads — one copy, `resources/pricing/model-aliases.json`.
const ALIASES_JSON: &str = include_str!("../../../resources/pricing/model-aliases.json");

/// The ids a non-maker provider books that the model's maker lists under
/// another id of the same model: id → maker key.
pub fn aliases() -> &'static HashMap<String, String> {
    static ALIASES: OnceLock<HashMap<String, String>> = OnceLock::new();
    ALIASES.get_or_init(|| {
        #[derive(Deserialize)]
        struct File {
            aliases: Vec<Alias>,
        }
        #[derive(Deserialize)]
        struct Alias {
            id: String,
            model: String,
        }
        serde_json::from_str::<File>(ALIASES_JSON)
            .expect("resources/pricing/model-aliases.json is an aliases list")
            .aliases
            .into_iter()
            .map(|alias| (alias.id, alias.model))
            .collect()
    })
}

/// Whether `maker` made the model whose base model is `base` (`<lab>/<model>`,
/// models.dev's canonical id). A maker lists other labs' models too, at its
/// own resale price — those are not its list price, and are not journaled.
/// The one rule both readers apply: [`parse_seed`] to the seed's history,
/// [`parse_api`] to the live catalogue.
pub fn made_by(maker: &str, base: &str) -> bool {
    let lab = makers_file().labs.get(maker).map_or(maker, String::as_str);
    base.split_once('/').is_some_and(|(of, _)| of == lab)
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
/// free — and so is one another lab made ([`made_by`]). `api.json` states one
/// cache-write rate, the 5-minute one; it has no 1-hour rate (see [`changes`]
/// for how that gap is carried).
pub fn parse_api(body: &str) -> Result<Vec<CatalogueEntry>, String> {
    let root: Value = serde_json::from_str(body).map_err(|e| format!("catalogue is not JSON: {e}"))?;
    let providers = root.as_object().ok_or("catalogue is not an object of providers")?;
    let mut entries = Vec::new();
    for maker in makers() {
        let Some(models) = providers.get(maker).and_then(|p| p.get("models")).and_then(Value::as_object) else {
            continue;
        };
        for (id, model) in models {
            let base = model.get("canonical_model_id").and_then(Value::as_str);
            if base.is_some_and(|base| !made_by(maker, base)) {
                continue;
            }
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

/// A price history as a seed holds it: models.dev's, read out of its git log.
#[derive(Debug, Clone, PartialEq)]
pub struct SeedHistory {
    /// The makers' own models' rows, by model, oldest first.
    pub rows: Vec<PriceRow>,
    /// When the models.dev commit the seed was read at was made: the history
    /// is complete up to here.
    pub until: f64,
}

/// The history in a seed file — only the models their maker made
/// ([`made_by`], by each model's base model): a maker's listing of another
/// lab's model is resale. A seed from a newer format is refused rather than
/// half-read.
pub fn parse_seed(body: &str) -> Result<SeedHistory, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Seed {
        version: u64,
        #[serde(default)]
        committed_at: f64,
        #[serde(default)]
        bases: HashMap<String, String>,
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
    let bases = seed.bases;
    let made = |model: &str| match (model.split_once('/'), bases.get(model)) {
        (Some((maker, _)), Some(base)) => made_by(maker, base),
        _ => true,
    };
    let mut rows: Vec<PriceRow> = seed
        .models
        .into_iter()
        .filter(|(model, _)| made(model))
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
    Ok(SeedHistory {
        rows,
        until: seed.committed_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal(rows: Vec<PriceRow>) -> Journal {
        Journal::new(rows, makers().to_vec(), aliases().clone())
    }

    #[test]
    fn every_shipped_alias_names_a_maker_key_the_seed_prices() {
        let journal = journal(seed().unwrap().rows);
        for (id, key) in aliases() {
            assert!(makers().iter().any(|maker| key.starts_with(&format!("{maker}/"))), "{id} → {key}: no maker's key");
            assert!(journal.latest(key).is_some(), "{id} → {key}: the seed has no price for it");
        }
        assert_eq!(journal.resolve("opencode/deepseek-v4.1-flash"), Some("deepseek/deepseek-flash"));
        assert_eq!(journal.resolve("kimi-code/k3-256k"), Some("moonshotai/kimi-k3"));
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
      } },
      "alibaba": { "models": {
        "qwen3.8-max": { "name": "Qwen 3.8 Max", "canonical_model_id": "alibaba/qwen3.8-max",
          "cost": { "input": 2, "output": 6 } },
        "deepseek-v4.1-flash": { "name": "DeepSeek resold", "canonical_model_id": "deepseek/deepseek-v4.1-flash",
          "cost": { "input": 0.3, "output": 1.2 } }
      } },
      "zai": { "models": {
        "glm-5.3": { "name": "GLM-5.3", "canonical_model_id": "zhipuai/glm-5.3", "cost": { "input": 1.4, "output": 4.4 } }
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
    fn a_maker_enters_only_with_the_models_its_own_lab_made() {
        let models: Vec<String> = parse_api(API).unwrap().into_iter().map(|e| e.model).collect();
        assert!(models.contains(&"alibaba/qwen3.8-max".to_string()));
        assert!(!models.contains(&"alibaba/deepseek-v4.1-flash".to_string()), "a resold model is not a list price");
        assert!(models.contains(&"zai/glm-5.3".to_string()), "a maker whose lab has another name keeps its own");
        assert!(made_by("alibaba-cn", "alibaba/qwen3.8-max"));
        assert!(!made_by("morph", "moonshotai/kimi-k3"));
        assert!(!made_by("anthropic", "no-lab"));
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
        let rows = parse_seed(seed).unwrap().rows;
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].model, "anthropic/claude-opus-5-5");
        assert_eq!(rows[0].price.rates.cache_write_1h, Some(8.0));
        assert_eq!(rows[0].price.tiers[0].over, 272_000);
        assert_eq!(rows[0].price.modes["fast"].cache_write_1h, Some(16.0));
        assert_eq!((rows[1].from, rows[2].from), (10.0, 20.0));
        assert_eq!(rows[1].price.rates.cache_write, None);
    }

    // The history this build ships reads, and prices the models KeepDeck's
    // agents run on as their makers list them.
    #[test]
    fn the_shipped_seed_reads_and_holds_the_makers_prices() {
        let seed = seed().expect("the shipped seed");
        assert!(seed.until > 0.0, "the seed says how far its history reaches");
        let rows = seed.rows;
        assert!(rows.len() > 500, "{} rows", rows.len());
        assert!(rows.iter().all(|row| !row.model.starts_with("alibaba/deepseek")), "no resold model is read");
        assert!(rows.iter().all(|row| makers().iter().any(|maker| row.model.starts_with(&format!("{maker}/")))));
        let latest = |model: &str| rows.iter().rfind(|row| row.model == model).expect(model).clone();
        let opus = latest("anthropic/claude-opus-5-5");
        assert_eq!((opus.price.rates.input, opus.price.rates.output), (4.0, 20.0));
        assert_eq!(opus.price.rates.cache_write_1h, Some(8.0));
        assert_eq!(opus.price.modes.get("fast").map(|fast| fast.output), Some(40.0));
        let sol = latest("openai/gpt-6.1-sol");
        assert_eq!(sol.price.tiers.first().map(|tier| (tier.over, tier.rates.input)), Some((272_000, 4.0)));
        assert_eq!(latest("zai/glm-5.3").price.rates.input, 1.4);
    }

    #[test]
    fn a_seed_is_read_without_the_models_a_maker_resells() {
        let entry = r#"[{ "from": 1, "input": 1, "output": 2, "tiers": [], "modes": {} }]"#;
        let seed = format!(
            r#"{{ "version": 1, "committedAt": 77,
                 "bases": {{ "alibaba/deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
                            "alibaba/qwen3.8-max": "alibaba/qwen3.8-max", "zai/glm-5.3": "zhipuai/glm-5.3" }},
                 "models": {{ "alibaba/deepseek-v4.1-flash": {entry}, "alibaba/qwen3.8-max": {entry},
                             "zai/glm-5.3": {entry}, "anthropic/claude-x": {entry} }} }}"#
        );
        let history = parse_seed(&seed).unwrap();
        let models: Vec<&str> = history.rows.iter().map(|row| row.model.as_str()).collect();
        assert_eq!(models, ["alibaba/qwen3.8-max", "anthropic/claude-x", "zai/glm-5.3"], "a model with no base stays");
        assert_eq!(history.until, 77.0);
    }

    #[test]
    fn a_seed_of_another_version_is_refused() {
        let err = parse_seed(r#"{ "version": 2, "models": {} }"#).unwrap_err();
        assert!(err.contains("version 2"), "{err}");
    }
}
