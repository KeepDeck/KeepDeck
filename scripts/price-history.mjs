#!/usr/bin/env node
// Builds the price-history seed the app ships
// (resources/pricing/model-prices.seed.json) from the git history of
// models.dev. models.dev serves only today's prices, but its source repo keeps
// one TOML per provider × model under git, so that history IS the price
// history: a call is priced at the price in effect when it happened. The Rust
// side (crates/keepdeck-usage) reads the seed into its `price` table; the
// seed's shape is that contract.
//
// Only the providers resources/pricing/makers.json names are read. History is
// the repo's first-parent line, the one models.dev publishes from: following
// side branches too would replay a branch's stale copy of a file as a price
// change and back. So an entry's `from` is the committer time of the commit
// that brought the price onto that line — for a pull request merged with a
// merge commit, the merge.
//
//   node scripts/price-history.mjs --repo <models.dev clone> \
//     [--out resources/pricing/model-prices.seed.json]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { isEntryPoint } from "./lib/entry.mjs";
import { isRecord } from "./lib/guards.mjs";

const SEED_VERSION = 1;
const SOURCE = "anomalyco/models.dev";
const MAKERS_FILE = fileURLToPath(new URL("../resources/pricing/makers.json", import.meta.url));
const CORRECTIONS_FILE = fileURLToPath(new URL("../resources/pricing/corrections.json", import.meta.url));
const DEFAULT_OUT = fileURLToPath(new URL("../resources/pricing/model-prices.seed.json", import.meta.url));
const SYMLINK_MODE = "120000";
export const NO_TEXT_PRICE = "no text input and output price";

/**
 * Prices in USD per 1M tokens. A price the source doesn't name is null,
 * never 0.
 * @typedef {{ input: number, output: number, cacheRead: number | null, cacheWrite: number | null, cacheWrite1h: number | null }} TextPrices
 * @typedef {{ over: number } & TextPrices} Tier the prices once the context exceeds `over` tokens
 * @typedef {TextPrices & { tiers: Tier[], modes: Record<string, TextPrices> }} PriceRow
 * @typedef {{ from: number, name: string | null } & PriceRow} SeedEntry
 * @typedef {{ version: number, source: string, commit: string, models: Record<string, SeedEntry[]> }} Seed
 * @typedef {{ key: string, from: number, name: string | null, row: PriceRow }} Revision
 * @typedef {{ row: PriceRow, ignored: string[] } | { skip: string }} Mapped
 * @typedef {{ over: number, prices: Record<string, unknown> }} Step a context override, or a schema-1 tier
 * @typedef {{ model: string, from: string, until: string, why: string }} Correction a span of a model's history models.dev fixed later
 */

/** A revision whose prices can't be read without guessing: it is skipped. */
class Uninterpretable extends Error {}

/**
 * One model file's canonical prices — the only fields a new seed entry is
 * decided on. `ignored` names the prices the file holds that the seed has no
 * field for (a separate reasoning price, a time-of-day discount…), so the run
 * can report what it drops.
 * @param {Record<string, unknown>} doc the parsed TOML, aliases resolved
 * @returns {Mapped}
 */
export function priceRow(doc) {
  /** @type {string[]} */
  const ignored = [];
  try {
    const schema = doc.schema ?? 1;
    if (schema !== 1 && schema !== 2) throw new Uninterpretable(`schema = ${String(schema)}`);
    const row = schema === 2 ? rowV2(doc, ignored) : rowV1(doc, ignored);
    return { row, ignored: [...new Set(ignored)] };
  } catch (error) {
    if (error instanceof Uninterpretable) return { skip: error.message };
    throw error;
  }
}

/**
 * Whether two rows price every token alike. A model's name, or how its file
 * spells the prices, is not a price.
 * @param {PriceRow} a
 * @param {PriceRow} b
 * @returns {boolean}
 */
export function samePrice(a, b) {
  return priceKey(a) === priceKey(b);
}

/**
 * Folds every priced revision, in commit order, into each model's entries. An
 * entry starts only where the canonical price changes; its name is the name
 * at that revision. A model whose file is deleted keeps its entries, and one
 * re-added later continues them.
 * @param {Revision[]} revisions
 * @returns {Record<string, SeedEntry[]>} by model key, sorted; each model's entries by `from`
 */
export function foldHistory(revisions) {
  /** @type {Map<string, SeedEntry[]>} */
  const models = new Map();
  for (const { key, from, name, row } of revisions) {
    let entries = models.get(key);
    if (entries === undefined) {
      entries = [];
      models.set(key, entries);
    }
    const last = entries.at(-1);
    if (last !== undefined && samePrice(last, row)) continue;
    // A price can't take effect before the one it replaced, so a clock that
    // ran backwards between commits can't reorder them.
    const entry = { from: last === undefined ? from : Math.max(from, last.from), name, ...row };
    if (last !== undefined && entry.from === last.from) {
      // Two prices in the same millisecond: the later commit's is the one that held.
      entries.pop();
      const before = entries.at(-1);
      if (before !== undefined && samePrice(before, row)) continue;
    }
    entries.push(entry);
  }
  return Object.fromEntries([...models].sort(([a], [b]) => compare(a, b)));
}

/**
 * The revisions with every correction applied: a revision of a corrected
 * model committed from the correction's `from` up to, not including, its
 * `until` takes the price the revision at `until` brought. A correction that
 * names a commit off the published line, a span running backwards, or an
 * `until` that did not touch the model fails the run: a stale correction
 * must be noticed, never quietly skipped.
 * @template {{ key: string, commit: string, row: PriceRow }} R
 * @param {R[]} revisions
 * @param {string[]} line the published line's commits, oldest first
 * @param {Correction[]} corrections
 * @returns {R[]}
 */
export function correctHistory(revisions, line, corrections) {
  const position = new Map(line.map((sha, index) => [sha, index]));
  /** @param {string} sha @param {Correction} correction */
  const at = (sha, correction) => {
    const index = position.get(sha);
    if (index === undefined) throw new Error(`correction of ${correction.model}: ${sha} is not on the published line`);
    return index;
  };
  let corrected = revisions;
  for (const correction of corrections) {
    const from = at(correction.from, correction);
    const until = at(correction.until, correction);
    if (from >= until) throw new Error(`correction of ${correction.model}: ${correction.from} is not before ${correction.until}`);
    const fix = corrected.find((revision) => revision.key === correction.model && revision.commit === correction.until);
    if (fix === undefined) throw new Error(`correction of ${correction.model}: ${correction.until} brought it no price`);
    corrected = corrected.map((revision) => {
      if (revision.key !== correction.model) return revision;
      const index = position.get(revision.commit) ?? -1;
      return index >= from && index < until ? { ...revision, row: fix.row } : revision;
    });
  }
  return corrected;
}

// ---------------------------------------------------------------- schema 1

const V1_PRICES = ["input", "output", "cache_read", "cache_write", "inputCached", "outputCached"];
/**
 * Other things a schema-1 cost prices, which the seed has no field for.
 * `cached_input`/`cached_write` were never schema keys: models.dev's lenient
 * schema dropped them, publishing no cache price, until 303081b3a renamed
 * them — so they read as dropped here too.
 */
const V1_UNCARRIED = ["reasoning", "input_audio", "output_audio", "citation", "request", "cached_input", "cached_write"];

/**
 * Schema 1: a flat `[cost]` — input, output, cache_read, cache_write — with
 * context tiers as `[[cost.tiers]] tier = { size }` or, earlier, one
 * `[cost.context_over_200k]`. A mode carries its own
 * `[experimental.modes.<name>.cost]`.
 * @param {Record<string, unknown>} doc
 * @param {string[]} ignored
 * @returns {PriceRow}
 */
function rowV1(doc, ignored) {
  if (doc.cost === undefined) throw new Uninterpretable(NO_TEXT_PRICE);
  const { tiers = [], context_over_200k: over200k, ...base } = record(doc.cost, "cost");
  /** @type {Step[]} */
  const steps = list(tiers, "cost.tiers").map((item) => {
    const { tier, ...prices } = record(item, "cost.tiers");
    const band = record(tier, "cost.tiers.tier");
    checkKeys(band, ["type", "size"], "cost.tiers.tier");
    if ((band.type ?? "context") !== "context" || typeof band.size !== "number") {
      throw new Uninterpretable(`cost.tiers.tier = ${JSON.stringify(band)}`);
    }
    return { over: band.size, prices };
  });
  if (over200k !== undefined) {
    steps.push({ over: 200_000, prices: record(over200k, "cost.context_over_200k") });
  }
  /** @type {Record<string, TextPrices>} */
  const modes = {};
  for (const [name, mode] of modeTables(doc)) {
    if (mode.cost === undefined) continue;
    const where = `experimental.modes.${name}.cost`;
    modes[name] = textPricesV1(record(mode.cost, where), where, ignored);
  }
  return {
    ...textPricesV1(base, "cost", ignored),
    tiers: contextTiers(steps, (over) => textPricesV1(pricesAbove(base, steps, over), "cost.tiers", ignored)),
    modes: sortedRecord(modes),
  };
}

/**
 * @param {Record<string, unknown>} cost
 * @param {string} where
 * @param {string[]} ignored
 * @returns {TextPrices}
 */
function textPricesV1(cost, where, ignored) {
  checkKeys(cost, [...V1_PRICES, ...V1_UNCARRIED], where);
  const output = requiredPrice(cost, "output", where);
  for (const key of V1_UNCARRIED) {
    const value = cost[key];
    if (value === undefined || key.endsWith("_audio")) continue;
    if (key === "reasoning" && value === output) continue;
    ignored.push(`${where}.${key}`);
  }
  return {
    input: requiredPrice(cost, "input", where),
    output,
    cacheRead: optionalPrice(cost, "cache_read", where) ?? legacyCachePrice(cost, "inputCached", where),
    cacheWrite: optionalPrice(cost, "cache_write", where) ?? legacyCachePrice(cost, "outputCached", where),
    cacheWrite1h: null,
  };
}

/**
 * The first schema's `inputCached`/`outputCached`, which models.dev renamed
 * cache_read/cache_write (19bc7d7cf). Both were required then, so $0 stood for
 * "no price"; the rename dropped those, and so does this.
 * @param {Record<string, unknown>} cost
 * @param {string} key
 * @param {string} where
 * @returns {number | null}
 */
function legacyCachePrice(cost, key, where) {
  const price = optionalPrice(cost, key, where);
  return price === 0 ? null : price;
}

// ---------------------------------------------------------------- schema 2

const V2_COST_KEYS = ["text", "multipliers", "image", "audio", "video", "web_search"];

/**
 * Schema 2: `[cost.text.input] price, cache = { read, write }` — write a number
 * or per TTL `{ "5m", "1h" }` — and `[cost.text.output] price`, each with
 * `[[…overrides]]` by context size; `[[cost.multipliers]]` price the modes
 * by service tier.
 * @param {Record<string, unknown>} doc
 * @param {string[]} ignored
 * @returns {PriceRow}
 */
function rowV2(doc, ignored) {
  if (doc.cost === undefined) throw new Uninterpretable(NO_TEXT_PRICE);
  const cost = record(doc.cost, "cost");
  const { input, output, inputSteps, outputSteps } = textSides(cost, "cost");
  return {
    ...textPricesV2(input, output, ignored),
    tiers: contextTiers([...inputSteps, ...outputSteps], (over) =>
      textPricesV2(pricesAbove(input, inputSteps, over), pricesAbove(output, outputSteps, over), ignored),
    ),
    modes: modesV2(doc, cost, input, output, ignored),
  };
}

/**
 * A schema-2 cost's text input and output tables, apart from their context
 * overrides.
 * @param {Record<string, unknown>} cost
 * @param {string} where
 */
function textSides(cost, where) {
  checkKeys(cost, V2_COST_KEYS, where);
  if (cost.text === undefined) throw new Uninterpretable(NO_TEXT_PRICE);
  const text = record(cost.text, `${where}.text`);
  checkKeys(text, ["input", "output"], `${where}.text`);
  if (text.input === undefined || text.output === undefined) throw new Uninterpretable(NO_TEXT_PRICE);
  const { overrides: inputOverrides = [], ...input } = record(text.input, `${where}.text.input`);
  const { overrides: outputOverrides = [], ...output } = record(text.output, `${where}.text.output`);
  return {
    input,
    output,
    inputSteps: contextSteps(inputOverrides, `${where}.text.input.overrides`),
    outputSteps: contextSteps(outputOverrides, `${where}.text.output.overrides`),
  };
}

/**
 * Overrides by context size. `gt` and `gte` both name where the band starts,
 * as models.dev's own one-price projection reads them (translate.ts): they
 * differ only for a context of exactly N tokens. Any other condition is a
 * price this seed can't place.
 * @param {unknown} overrides
 * @param {string} where
 * @returns {Step[]}
 */
function contextSteps(overrides, where) {
  return list(overrides, where).map((item) => {
    const { when, ...prices } = record(item, where);
    const context = isRecord(when) && Object.keys(when).length === 1 && isRecord(when.context) ? when.context : {};
    const bounds = Object.keys(context);
    const over = bounds.length === 1 && (bounds[0] === "gt" || bounds[0] === "gte") ? context[bounds[0]] : undefined;
    if (typeof over !== "number") throw new Uninterpretable(`${where} when ${JSON.stringify(when)}`);
    return { over, prices };
  });
}

/**
 * @param {Record<string, unknown>} input `[cost.text.input]` without overrides
 * @param {Record<string, unknown>} output `[cost.text.output]` without overrides
 * @param {string[]} ignored
 * @returns {TextPrices}
 */
function textPricesV2(input, output, ignored) {
  checkKeys(input, ["price", "cache", "unit"], "cost.text.input");
  checkKeys(output, ["price", "reasoning", "unit"], "cost.text.output");
  for (const [side, unit] of [["input", input.unit], ["output", output.unit]]) {
    if ((unit ?? "token") !== "token") throw new Uninterpretable(`text ${side} priced per ${String(unit)}`);
  }
  const outputPrice = requiredPrice(output, "price", "cost.text.output");
  if (output.reasoning !== undefined && output.reasoning !== outputPrice) {
    ignored.push("cost.text.output.reasoning");
  }
  const cache = input.cache === undefined ? {} : record(input.cache, "cost.text.input.cache");
  checkKeys(cache, ["read", "write", "explicit", "storage"], "cost.text.input.cache");
  const explicit = cache.explicit === undefined ? {} : record(cache.explicit, "cost.text.input.cache.explicit");
  checkKeys(explicit, ["read", "write", "storage"], "cost.text.input.cache.explicit");
  if (cache.storage !== undefined || explicit.storage !== undefined) ignored.push("cost.text.input.cache.storage");
  if (explicit.read !== undefined) ignored.push("cost.text.input.cache.explicit.read");
  // models.dev's own one-write-price reading (translate.ts cacheWrite):
  // implicit caching has no write fee, so a file that prices only an explicit
  // cache write has that one.
  const [cacheWrite, cacheWrite1h] = writePrices(cache.write ?? explicit.write);
  return {
    input: requiredPrice(input, "price", "cost.text.input"),
    output: outputPrice,
    cacheRead: optionalPrice(cache, "read", "cost.text.input.cache"),
    cacheWrite,
    cacheWrite1h,
  };
}

/**
 * @param {unknown} write a price, or prices by TTL
 * @returns {[number | null, number | null]} the 5-minute (or only) write, and the 1-hour one
 */
function writePrices(write) {
  const where = "cost.text.input.cache.write";
  if (write === undefined) return [null, null];
  if (typeof write === "number") return [optionalPrice({ write }, "write", where), null];
  const byTtl = record(write, where);
  checkKeys(byTtl, ["5m", "1h"], where);
  return [optionalPrice(byTtl, "5m", where), optionalPrice(byTtl, "1h", where)];
}

/**
 * A mode's prices: its own `cost` when it has one (a price that isn't a plain
 * multiple of the base), else the base scaled by the first multiplier on the
 * mode's service tier — `service_tier` when the mode names one, else the
 * mode's name. Tiers aren't given per mode, so none are carried. A mode no
 * multiplier prices is left out, as are multipliers on anything but a service
 * tier (region, date, time of day).
 * @param {Record<string, unknown>} doc
 * @param {Record<string, unknown>} cost
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} output
 * @param {string[]} ignored
 * @returns {Record<string, TextPrices>}
 */
function modesV2(doc, cost, input, output, ignored) {
  /** @type {Map<string, unknown>} */
  const factors = new Map();
  for (const item of list(cost.multipliers ?? [], "cost.multipliers")) {
    const multiplier = record(item, "cost.multipliers");
    const when = record(multiplier.when, "cost.multipliers.when");
    const tier = Object.keys(when).length === 1 && isRecord(when.service_tier) ? when.service_tier.equals : undefined;
    if (typeof tier !== "string") {
      ignored.push(`cost.multipliers on ${Object.keys(when).join("+")}`);
      continue;
    }
    if (!factors.has(tier)) factors.set(tier, multiplier.factor);
  }
  /** @type {Record<string, TextPrices>} */
  const modes = {};
  for (const [name, mode] of modeTables(doc)) {
    if (mode.cost !== undefined) {
      const where = `experimental.modes.${name}.cost`;
      const own = textSides(record(mode.cost, where), where);
      modes[name] = textPricesV2(own.input, own.output, ignored);
      continue;
    }
    const tier = mode.service_tier ?? name;
    if (typeof tier !== "string") throw new Uninterpretable(`experimental.modes.${name}.service_tier`);
    const factor = factors.get(tier);
    if (factor === undefined) continue;
    modes[name] = textPricesV2(
      scaled(input, factor, ["text", "input"]),
      scaled(output, factor, ["text", "output"]),
      ignored,
    );
  }
  return sortedRecord(modes);
}

/**
 * Every price in `table` times its factor.
 * @param {Record<string, unknown>} table
 * @param {unknown} factor
 * @param {string[]} path where `table` sits in the cost
 * @returns {Record<string, unknown>}
 */
function scaled(table, factor, path) {
  return Object.fromEntries(
    Object.entries(table).map(([key, value]) => {
      const at = [...path, key];
      if (typeof value === "number") return [key, roundPrice(value * factorAt(factor, at))];
      return [key, isRecord(value) ? scaled(value, factor, at) : value];
    }),
  );
}

/**
 * A multiplier's factor at one price: a number scales every price below it,
 * and a price an object factor doesn't name keeps factor 1 (`{ text = 2 }`
 * leaves web search alone) — models.dev's rule (translate.ts factorAt).
 * @param {unknown} factor
 * @param {string[]} path
 * @returns {number}
 */
function factorAt(factor, path) {
  let node = factor;
  for (const key of path) {
    if (typeof node === "number" || !isRecord(node)) break;
    node = node[key];
  }
  if (typeof node === "number") return node;
  if (node === undefined) return 1;
  throw new Uninterpretable(`multiplier factor at ${path.join(".")}`);
}

/**
 * Drops float noise from a scaled price (0.1 × 6 = 0.6000000000000001), the
 * way models.dev rounds its own (translate.ts roundPrice).
 * @param {number} price
 */
function roundPrice(price) {
  return Math.round(price * 1e10) / 1e10;
}

// ---------------------------------------------------------------- shared

/**
 * @param {Record<string, unknown>} doc
 * @returns {[string, Record<string, unknown>][]}
 */
function modeTables(doc) {
  // `experimental = true` once flagged a model, with no modes.
  if (!isRecord(doc.experimental) || doc.experimental.modes === undefined) return [];
  return Object.entries(record(doc.experimental.modes, "experimental.modes")).map(([name, mode]) => [
    name,
    record(mode, `experimental.modes.${name}`),
  ]);
}

/**
 * One tier per threshold, ascending.
 * @param {Step[]} steps
 * @param {(over: number) => TextPrices} priceAbove
 * @returns {Tier[]}
 */
function contextTiers(steps, priceAbove) {
  return [...new Set(steps.map((step) => step.over))]
    .sort((a, b) => a - b)
    .map((over) => ({ over, ...priceAbove(over) }));
}

/**
 * The prices in force above `over`: every step at or below it merged over the
 * base in file order, field by field — models.dev's rule for matching
 * overrides — so a field a step leaves out keeps the base's value (or a
 * lower step's).
 * @param {Record<string, unknown>} base
 * @param {Step[]} steps
 * @param {number} over
 * @returns {Record<string, unknown>}
 */
function pricesAbove(base, steps, over) {
  return steps.filter((step) => step.over <= over).reduce((merged, step) => deepMerge(merged, step.prices), base);
}

/**
 * `over` laid onto `base`: tables merge key by key, anything else replaces.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} over
 * @returns {Record<string, unknown>}
 */
function deepMerge(base, over) {
  /** @type {Record<string, unknown>} */
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

/**
 * @param {Record<string, unknown>} table
 * @param {string} key
 * @param {string} where
 * @returns {number | null}
 */
function optionalPrice(table, key, where) {
  const value = table[key];
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Uninterpretable(`${where}.${key} = ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} table
 * @param {string} key
 * @param {string} where
 * @returns {number}
 */
function requiredPrice(table, key, where) {
  const value = optionalPrice(table, key, where);
  if (value === null) throw new Uninterpretable(NO_TEXT_PRICE);
  return value;
}

/**
 * A key nobody told this script about may change what the others mean.
 * @param {Record<string, unknown>} table
 * @param {string[]} known
 * @param {string} where
 */
function checkKeys(table, known, where) {
  const unknown = Object.keys(table).find((key) => !known.includes(key));
  if (unknown !== undefined) throw new Uninterpretable(`unknown key ${where}.${unknown}`);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
function record(value, where) {
  if (!isRecord(value)) throw new Uninterpretable(`${where} is not a table`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {unknown[]}
 */
function list(value, where) {
  if (!Array.isArray(value)) throw new Uninterpretable(`${where} is not a list`);
  return value;
}

/**
 * @template T
 * @param {Record<string, T>} table
 * @returns {Record<string, T>}
 */
function sortedRecord(table) {
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => compare(a, b)));
}

/**
 * @param {string} a
 * @param {string} b
 */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {PriceRow} row
 * @returns {string}
 */
function priceKey(row) {
  /** @param {TextPrices} prices */
  const text = (prices) => [prices.input, prices.output, prices.cacheRead, prices.cacheWrite, prices.cacheWrite1h];
  return JSON.stringify([
    text(row),
    [...row.tiers].sort((a, b) => a.over - b.over).map((tier) => [tier.over, ...text(tier)]),
    Object.keys(row.modes)
      .sort(compare)
      .map((name) => [name, ...text(row.modes[name])]),
  ]);
}

// ---------------------------------------------------------------- git

/**
 * @typedef {{ path: string, mode: string, blob: string | null }} Change a file's new state; blob null when deleted
 * @typedef {{ sha: string, time: number, changes: Change[] }} Commit
 * @typedef {{ doc: Record<string, unknown> } | { skip: string }} Resolution
 * @typedef {{ revisions: number, models: Set<string>, examples: string[] }} Tally
 */

/**
 * @param {string} repo
 * @param {string[]} args
 * @param {string} [input]
 * @returns {Buffer}
 */
function git(repo, args, input) {
  return execFileSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], {
    input,
    maxBuffer: 1 << 30,
  });
}

/**
 * Every first-parent commit that touched a maker's model files, oldest first,
 * with the files' new states. A merge counts as its diff against the line it
 * landed on.
 * @param {string} repo
 * @param {string} head
 * @param {string[]} makers
 * @returns {Commit[]}
 */
function readHistory(repo, head, makers) {
  const log = git(repo, [
    "log", "--first-parent", "--diff-merges=first-parent", "--root", "--reverse",
    "--no-renames", "--raw", "--no-abbrev", "--format=commit %H %ct", head,
    "--", ...makers.map((maker) => `providers/${maker}/models`),
  ]).toString("utf8");
  /** @type {Commit[]} */
  const commits = [];
  for (const line of log.split("\n")) {
    const commit = /^commit ([0-9a-f]+) (\d+)$/.exec(line);
    if (commit) {
      commits.push({ sha: commit[1], time: Number(commit[2]) * 1000, changes: [] });
      continue;
    }
    const change = /^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*\t(.+)$/.exec(line);
    if (change) {
      commits.at(-1)?.changes.push({ path: change[3], mode: change[1], blob: /^0+$/.test(change[2]) ? null : change[2] });
    }
  }
  return commits;
}

/**
 * Many objects through one `git cat-file --batch`: a process per object
 * would spend seconds on spawns alone.
 * @param {string} repo
 * @param {string[]} specs object names: `<blob>`, `<commit>:<path>`
 * @returns {Map<string, string>} the blobs found, by spec
 */
function catFile(repo, specs) {
  /** @type {Map<string, string>} */
  const found = new Map();
  if (specs.length === 0) return found;
  const out = git(repo, ["cat-file", "--batch"], `${specs.join("\n")}\n`);
  let at = 0;
  for (const spec of specs) {
    const eol = out.indexOf(10, at);
    const [, type, size] = out.toString("utf8", at, eol).split(" ");
    at = eol + 1;
    if (size === undefined) continue; // `<spec> missing`
    const end = at + Number(size);
    if (type === "blob") found.set(spec, out.toString("utf8", at, end));
    at = end + 1;
  }
  return found;
}

/**
 * `<provider>/<model id>` for a model file — the id is its path under the
 * provider's models directory, as models.dev names it — or null for any
 * other file.
 * @param {string} path
 * @returns {string | null}
 */
function modelKey(path) {
  const match = /^providers\/([^/]+)\/models\/(.+)\.toml$/.exec(path);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Walks the history forward, keeping the tree of maker files, and resolves
 * each model's document wherever it may have changed: where its own file did,
 * or a file it reads — a symlinked alias reads its target, an `[extends]`
 * file the model it extends. Those re-price the alias without touching it.
 * @param {Commit[]} commits
 * @param {Map<string, string>} blobs
 * @returns {Array<{ key: string, from: number, commit: string } & Resolution>}
 */
function replay(commits, blobs) {
  /** @type {Map<string, { mode: string, blob: string }>} */
  const tree = new Map();
  /** @type {Map<string, string[]>} the other files each model's document was read from */
  const reads = new Map();
  /** @type {Map<string, Record<string, unknown> | null>} */
  const parsed = new Map();
  /** @param {string} blob */
  const parseBlob = (blob) => {
    if (!parsed.has(blob)) parsed.set(blob, parseDoc(blobs.get(blob) ?? ""));
    return parsed.get(blob) ?? null;
  };

  /**
   * @param {string} path
   * @param {Set<string>} visited
   * @returns {Resolution}
   */
  const resolve = (path, visited) => {
    if (visited.has(path)) return { skip: `alias loop at ${path}` };
    visited.add(path);
    const file = tree.get(path);
    if (file === undefined) return { skip: "alias target absent" };
    if (file.mode === SYMLINK_MODE) {
      return resolve(posix.join(posix.dirname(path), (blobs.get(file.blob) ?? "").trim()), visited);
    }
    const doc = parseBlob(file.blob);
    if (doc === null) return { skip: "TOML parse error" };
    if (doc.extends === undefined) return { doc };
    // Before base_model, models.dev (2026-04 to 06) let a file take another
    // provider's model whole with `[extends] from = "<provider>/<model>"`,
    // its own fields merged over.
    const { extends: extend, ...own } = doc;
    if (!isRecord(extend) || typeof extend.from !== "string" || !/^[^/]+\/[^/]+$/.test(extend.from)) {
      return { skip: "extends.from" };
    }
    // Every `[extends]` a maker ever wrote omitted nothing; dropping fields
    // from the base is left unread rather than half-read.
    if (extend.omit !== undefined && !(Array.isArray(extend.omit) && extend.omit.length === 0)) {
      return { skip: "extends.omit" };
    }
    const [provider, model] = extend.from.split("/");
    const base = resolve(`providers/${provider}/models/${model}.toml`, visited);
    return "skip" in base ? base : { doc: deepMerge(base.doc, own) };
  };

  /** @type {Array<{ key: string, from: number, commit: string } & Resolution>} */
  const resolved = [];
  for (const commit of commits) {
    const changed = new Set(commit.changes.map((change) => change.path));
    for (const { path, mode, blob } of commit.changes) {
      if (blob === null) {
        tree.delete(path);
        reads.delete(path);
      } else {
        tree.set(path, { mode, blob });
      }
    }
    for (const path of tree.keys()) {
      const key = modelKey(path);
      if (key === null) continue;
      if (!changed.has(path) && !(reads.get(path) ?? []).some((read) => changed.has(read))) continue;
      /** @type {Set<string>} */
      const visited = new Set();
      const resolution = resolve(path, visited);
      visited.delete(path);
      reads.set(path, [...visited]);
      resolved.push({ key, from: commit.time, commit: commit.sha, ...resolution });
    }
  }
  return resolved;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseDoc(text) {
  try {
    return parseToml(text);
  } catch {
    return null;
  }
}

/**
 * @param {Map<string, Tally>} tallies
 * @param {string} reason
 * @param {string} key
 * @param {string} commit
 */
function tally(tallies, reason, key, commit) {
  let entry = tallies.get(reason);
  if (entry === undefined) {
    entry = { revisions: 0, models: new Set(), examples: [] };
    tallies.set(reason, entry);
  }
  entry.revisions += 1;
  if (!entry.models.has(key) && entry.examples.length < 3) entry.examples.push(`${key}@${commit.slice(0, 9)}`);
  entry.models.add(key);
}

/**
 * Whether `maker` made the model whose base model is `base` (`<lab>/<model>`):
 * a maker lists other labs' models too, at its own resale price.
 * @param {string} maker
 * @param {string} base
 * @param {Record<string, string>} labs a maker's lab where it differs from its id
 */
export function madeBy(maker, base, labs) {
  return base.split("/")[0] === (labs[maker] ?? maker) && base.includes("/");
}

/**
 * Reads the price history of `makers` out of a models.dev clone: only the
 * models each one made itself — one any revision bases on another lab's is
 * resold — and the spans models.dev fixed later read with their fix (see
 * {@link correctHistory}).
 * @param {string} repo
 * @param {string[]} makers
 * @param {Correction[]} [corrections]
 * @param {Record<string, string>} [labs]
 */
export function buildSeed(repo, makers, corrections = [], labs = {}) {
  const head = git(repo, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const commits = readHistory(repo, head, makers);
  const blobIds = new Set(commits.flatMap((commit) => commit.changes.flatMap((change) => change.blob ?? [])));
  const blobs = catFile(repo, [...blobIds]);

  /** @type {Map<string, Tally>} */
  const skipped = new Map();
  /** @type {Map<string, Tally>} */
  const ignored = new Map();
  /** @type {Set<string>} */
  const variants = new Set();
  /** @type {Array<{ key: string, from: number, commit: string, doc: Record<string, unknown>, row: PriceRow }>} */
  const priced = [];
  for (const revision of replay(commits, blobs)) {
    // A deployment variant (`model@deployment`) is not a model of its own.
    if (revision.key.includes("@")) {
      variants.add(revision.key);
      continue;
    }
    if ("skip" in revision) {
      tally(skipped, revision.skip, revision.key, revision.commit);
      continue;
    }
    const mapped = priceRow(revision.doc);
    if ("skip" in mapped) {
      tally(skipped, mapped.skip, revision.key, revision.commit);
      continue;
    }
    for (const note of mapped.ignored) tally(ignored, note, revision.key, revision.commit);
    priced.push({ key: revision.key, from: revision.from, commit: revision.commit, doc: revision.doc, row: mapped.row });
  }

  /** @type {Set<string>} */
  const resold = new Set();
  for (const { key, doc } of priced) {
    if (typeof doc.base_model === "string" && !madeBy(key.split("/")[0], doc.base_model, labs)) resold.add(key);
  }
  const own = priced.filter((revision) => !resold.has(revision.key));
  const corrected = correctHistory(own, commits.map((commit) => commit.sha), corrections);

  // A file that names no model inherits the name of its base model
  // (models/<lab>/<model>.toml), as it stood in the same commit.
  /** @param {{ commit: string, doc: Record<string, unknown> }} revision */
  const baseSpec = ({ commit, doc }) =>
    typeof doc.name !== "string" && typeof doc.base_model === "string" ? `${commit}:models/${doc.base_model}.toml` : null;
  const baseFiles = catFile(repo, [...new Set(corrected.flatMap((revision) => baseSpec(revision) ?? []))]);
  let unnamed = 0;
  /** @type {Revision[]} */
  const revisions = corrected.map((revision) => {
    const spec = baseSpec(revision);
    const baseName = spec === null ? undefined : parseDoc(baseFiles.get(spec) ?? "")?.name;
    const name = typeof revision.doc.name === "string" ? revision.doc.name : typeof baseName === "string" ? baseName : null;
    if (name === null) unnamed += 1;
    return { key: revision.key, from: revision.from, name, row: revision.row };
  });

  /** @type {Seed} */
  const seed = { version: SEED_VERSION, source: SOURCE, commit: head, models: foldHistory(revisions) };
  const neverPriced = new Set([...skipped.values()].flatMap((entry) => [...entry.models]));
  for (const key of [...Object.keys(seed.models), ...resold]) neverPriced.delete(key);
  return { seed, skipped, ignored, variants, unnamed, neverPriced, resold };
}

// ---------------------------------------------------------------- CLI

/**
 * @param {string[]} argv
 * @returns {{ repo: string, out: string }}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let repo;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--repo") repo = argv[++i];
    else if (flag === "--out") out = argv[++i] ?? "";
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!repo) throw new Error("--repo is required");
  if (!out) throw new Error("--out needs a path");
  return { repo, out };
}

/**
 * The providers whose list price the journal records.
 * @param {string} [file]
 * @returns {string[]}
 */
export function readMakers(file = MAKERS_FILE) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const makers = isRecord(parsed) ? parsed.makers : undefined;
  if (!Array.isArray(makers) || makers.length === 0 || !makers.every((maker) => typeof maker === "string")) {
    throw new Error(`${file}: "makers" must be a non-empty list of provider ids`);
  }
  return makers;
}

/**
 * Each maker's lab, where it is not the maker's own id.
 * @param {string} [file]
 * @returns {Record<string, string>}
 */
export function readLabs(file = MAKERS_FILE) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const labs = isRecord(parsed) ? (parsed.labs ?? {}) : undefined;
  if (!isRecord(labs) || !Object.values(labs).every((lab) => typeof lab === "string")) {
    throw new Error(`${file}: "labs" must map provider ids to lab ids`);
  }
  return /** @type {Record<string, string>} */ (labs);
}

/**
 * The spans of models.dev's history it fixed later.
 * @param {string} [file]
 * @returns {Correction[]}
 */
export function readCorrections(file = CORRECTIONS_FILE) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const corrections = isRecord(parsed) ? parsed.corrections : undefined;
  const fields = ["model", "from", "until", "why"];
  if (
    !Array.isArray(corrections) ||
    !corrections.every((entry) => isRecord(entry) && fields.every((field) => typeof entry[field] === "string" && entry[field] !== ""))
  ) {
    throw new Error(`${file}: "corrections" must be a list of { ${fields.join(", ")} }`);
  }
  return /** @type {Correction[]} */ (corrections);
}

/**
 * The seed as JSON with one entry per line: small enough to ship, and a
 * new price shows in a diff as the line it adds.
 * @param {Seed} seed
 * @returns {string}
 */
export function formatSeed(seed) {
  const models = Object.entries(seed.models).map(
    ([key, entries]) => `    ${JSON.stringify(key)}: [\n${entries.map((entry) => `      ${JSON.stringify(entry)}`).join(",\n")}\n    ]`,
  );
  return [
    "{",
    `  "version": ${JSON.stringify(seed.version)},`,
    `  "source": ${JSON.stringify(seed.source)},`,
    `  "commit": ${JSON.stringify(seed.commit)},`,
    `  "models": {${models.length === 0 ? "}" : `\n${models.join(",\n")}\n  }`}`,
    "}",
    "",
  ].join("\n");
}

/**
 * @param {string} title
 * @param {Map<string, Tally>} tallies
 */
function printTallies(title, tallies) {
  if (tallies.size === 0) return;
  console.log(title);
  for (const [reason, { revisions, models, examples }] of [...tallies].sort(([, a], [, b]) => b.revisions - a.revisions)) {
    console.log(`  ${revisions} revisions of ${models.size} models: ${reason} (e.g. ${examples.join(", ")})`);
  }
}

/**
 * @param {string[]} [argv]
 */
export function main(argv = process.argv.slice(2)) {
  const { repo, out } = parseArgs(argv);
  const corrections = readCorrections();
  const { seed, skipped, ignored, variants, unnamed, neverPriced, resold } = buildSeed(
    repo,
    readMakers(),
    corrections,
    readLabs(),
  );
  const text = formatSeed(seed);
  writeFileSync(out, text);
  const entries = Object.values(seed.models).reduce((sum, model) => sum + model.length, 0);
  console.log(
    `Wrote ${out}: ${Object.keys(seed.models).length} models, ${entries} entries, ` +
      `${Buffer.byteLength(text)} bytes, from ${seed.source}@${seed.commit}, ${corrections.length} correction(s) applied`,
  );
  printTallies("Skipped revisions (the price before them holds):", skipped);
  printTallies("Prices the seed has no field for (dropped):", ignored);
  if (resold.size > 0) console.log(`Resold models left out: ${resold.size} (${[...resold].slice(0, 8).join(", ")}…)`);
  if (neverPriced.size > 0) console.log(`Models never priced: ${neverPriced.size} (${[...neverPriced].slice(0, 8).join(", ")}…)`);
  if (variants.size > 0) console.log(`Deployment variants skipped: ${[...variants].join(", ")}`);
  if (unnamed > 0) console.log(`Revisions with no resolvable name: ${unnamed}`);
  return seed;
}

if (isEntryPoint(import.meta.url)) {
  main();
}
