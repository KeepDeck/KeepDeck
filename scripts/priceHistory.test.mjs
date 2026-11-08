import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_TEXT_PRICE,
  buildSeed,
  correctHistory,
  foldHistory,
  formatSeed,
  parseArgs,
  priceRow,
  readCorrections,
  readMakers,
  samePrice,
} from "./price-history.mjs";

/**
 * @param {string} toml
 * @returns {import("./price-history.mjs").PriceRow}
 */
function row(toml) {
  const mapped = priceRow(parse(toml));
  if ("skip" in mapped) throw new Error(`skipped: ${mapped.skip}`);
  return mapped.row;
}

/** @param {string} toml */
const skipReason = (toml) => {
  const mapped = priceRow(parse(toml));
  return "skip" in mapped ? mapped.skip : null;
};

/**
 * @param {Pick<import("./price-history.mjs").TextPrices, "input" | "output"> & Partial<import("./price-history.mjs").TextPrices>} prices
 * @returns {import("./price-history.mjs").TextPrices}
 */
const text = (prices) => ({ cacheRead: null, cacheWrite: null, cacheWrite1h: null, ...prices });

// openai/gpt-6.1-sol in schema 1 (models.dev 36f18836) and schema 2 (HEAD):
// the same prices, spelled two ways.
const SOL_V1 = `
name = "GPT-6.1 Sol"

[cost]
input = 2
output = 10
cache_read = 0.1
cache_write = 2.5

[[cost.tiers]]
tier = { type = "context", size = 272_000 }
input = 4
output = 15
cache_read = 0.2
cache_write = 5

[experimental.modes.fast]
cost = { input = 4, output = 20, cache_read = 0.2, cache_write = 5 }
provider = { body = { service_tier = "priority" } }

[experimental.modes.ultrafast]
cost = { input = 12, output = 60, cache_read = 0.6, cache_write = 15 }

[experimental.modes.pro]
provider = { body = { reasoning = { mode = "pro" } } }
`;

const SOL_V2 = `
schema = 2
base_model = "openai/gpt-6.1-sol"

[cost.text.input]
price = 2
cache = { read = 0.1, write = 2.5 }

[[cost.text.input.overrides]]
when = { context = { gt = 272_000 } }
price = 4
cache = { read = 0.2, write = 5 }

[cost.text.output]
price = 10

[[cost.text.output.overrides]]
when = { context = { gt = 272_000 } }
price = 15

[cost.web_search]
price = 10

[[cost.multipliers]]
when = { service_tier = { equals = "priority" } }
factor = { text = 2 }

[[cost.multipliers]]
when = { service_tier = { equals = "ultrafast" } }
factor = { text = 6 }

[[cost.multipliers]]
when = { service_tier = { equals = "flex" } }
factor = { text = 0.5 }

[experimental.modes.fast]
service_tier = "priority"
body = { service_tier = "priority" }

[experimental.modes.pro]
body = { reasoning = { mode = "pro" } }

[experimental.modes.ultrafast]
body = { service_tier = "ultrafast" }
`;

const SOL = {
  ...text({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }),
  tiers: [{ over: 272_000, ...text({ input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }) }],
  modes: {
    fast: text({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }),
    ultrafast: text({ input: 12, output: 60, cacheRead: 0.6, cacheWrite: 15 }),
  },
};

// anthropic/claude-opus-5-5 at HEAD.
const OPUS_V2 = `
schema = 2
base_model = "anthropic/claude-opus-5-5"

[cost.text.input]
price = 4
cache = { read = 0.2, write = { "5m" = 5, "1h" = 8 } }

[cost.text.output]
price = 20

[[cost.multipliers]]
when = { service_tier = { equals = "fast" } }
factor = { text = 2 }

[[cost.multipliers]]
when = { region = { equals = "us" } }
factor = { text = 1.1 }

[experimental.modes.fast]
body = { speed = "fast" }
headers = { anthropic-beta = "fast-mode-2026-02-01" }
`;

describe("priceRow", () => {
  it("reads a schema-1 [cost], its context tiers, and its modes' own prices", () => {
    // `pro` has no price of its own, so it is left out.
    expect(row(SOL_V1)).toEqual(SOL);
  });

  it("reads schema-1 context_over_200k as a tier above 200,000 that inherits what it leaves out", () => {
    const toml = `
      [cost]
      input = 5
      output = 30
      cache_read = 0.5
      [cost.context_over_200k]
      input = 10
      output = 45
    `;
    expect(row(toml).tiers).toEqual([{ over: 200_000, ...text({ input: 10, output: 45, cacheRead: 0.5 }) }]);
  });

  it("reads the first schema's inputCached/outputCached as cache read/write, and $0 there as no price", () => {
    const toml = `
      [cost]
      input = 0.4
      output = 1.6
      inputCached = 0.1
      outputCached = 0
    `;
    expect(row(toml)).toMatchObject(text({ input: 0.4, output: 1.6, cacheRead: 0.1 }));
  });

  it("reads schema 2 with 5-minute and 1-hour cache writes", () => {
    const toml = `
      schema = 2
      [cost.text.input]
      price = 4
      cache = { read = 0.2, write = { "5m" = 5, "1h" = 8 } }
      [cost.text.output]
      price = 20
    `;
    expect(row(toml)).toEqual({
      input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8, tiers: [], modes: {},
    });
  });

  it("turns context overrides into a tier, a field an override leaves out keeping the base's", () => {
    const toml = `
      schema = 2
      [cost.text.input]
      price = 2
      cache = { read = 0.1, write = 2.5 }
      [[cost.text.input.overrides]]
      when = { context = { gt = 272_000 } }
      price = 4
      [cost.text.output]
      price = 10
      [[cost.text.output.overrides]]
      when = { context = { gt = 272_000 } }
      price = 15
    `;
    expect(row(toml).tiers).toEqual([
      { over: 272_000, ...text({ input: 4, output: 15, cacheRead: 0.1, cacheWrite: 2.5 }) },
    ]);
  });

  it("prices anthropic's fast mode by the fast multiplier, and ignores the region one", () => {
    const mapped = priceRow(parse(OPUS_V2));
    expect(mapped).toEqual({
      row: {
        input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8, tiers: [],
        modes: { fast: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, cacheWrite1h: 16 } },
      },
      ignored: ["cost.multipliers on region"],
    });
  });

  it("prices openai's fast mode by the priority tier it names, and a mode without one by its own name", () => {
    // fast → priority ×2; ultrafast → ultrafast ×6 (0.1 × 6 rounded clean);
    // pro has no multiplier, and flex prices no mode.
    expect(row(SOL_V2)).toEqual(SOL);
  });

  it("skips a revision that lacks input or output", () => {
    expect(skipReason(`[cost]\ninput = 1`)).toBe(NO_TEXT_PRICE);
    expect(skipReason(`name = "No price"`)).toBe(NO_TEXT_PRICE);
    expect(skipReason(`schema = 2\n[cost.text.input]\nprice = 0.6\n[cost.audio.output]\nprice = 12`)).toBe(NO_TEXT_PRICE);
  });

  it("skips a shape it can't read rather than guess a price", () => {
    expect(skipReason(`schema = 2\n[cost.text.input]\nunit = "character"\nprice = 30\n[cost.text.output]\nprice = 1`))
      .toBe("text input priced per character");
    expect(skipReason(`[cost]\ninput = 1\noutput = 2\ncache_hit = 0.1`)).toBe("unknown key cost.cache_hit");
    expect(
      skipReason(`schema = 2
        [cost.text.input]
        price = 1
        [[cost.text.input.overrides]]
        when = { region = { equals = "eu" } }
        price = 2
        [cost.text.output]
        price = 2`),
    ).toMatch(/^cost\.text\.input\.overrides when/);
  });
});

describe("samePrice", () => {
  it("holds across a schema rewrite with the same numbers", () => {
    expect(samePrice(row(SOL_V1), row(SOL_V2))).toBe(true);
  });

  it("sees a change in a tier or a mode", () => {
    const tierMoved = { ...SOL, tiers: [{ ...SOL.tiers[0], over: 200_000 }] };
    const { ultrafast: _ultrafast, ...fewerModes } = SOL.modes;
    expect(samePrice(SOL, tierMoved)).toBe(false);
    expect(samePrice(SOL, { ...SOL, modes: fewerModes })).toBe(false);
    expect(samePrice(SOL, { ...SOL, cacheWrite1h: 0 })).toBe(false);
  });
});

describe("foldHistory", () => {
  const T = 1_700_000_000_000;

  it("starts no entry for a representation-only rewrite", () => {
    expect(
      foldHistory([
        { key: "openai/gpt-6.1-sol", from: T, name: "GPT-6.1 Sol", row: row(SOL_V1) },
        { key: "openai/gpt-6.1-sol", from: T + 1000, name: "GPT 6.1 Sol (renamed)", row: row(SOL_V2) },
      ]),
    ).toEqual({ "openai/gpt-6.1-sol": [{ from: T, name: "GPT-6.1 Sol", ...SOL }] });
  });

  it("starts an entry, dated by its commit, where the price changes", () => {
    const raised = row(SOL_V2.replace("price = 2\n", "price = 3\n"));
    const folded = foldHistory([
      { key: "openai/gpt-6.1-sol", from: T, name: "GPT-6.1 Sol", row: row(SOL_V2) },
      { key: "openai/gpt-6.1-sol", from: T + 1000, name: "GPT-6.1 Sol", row: raised },
    ]);
    expect(folded["openai/gpt-6.1-sol"].map((entry) => [entry.from, entry.input])).toEqual([
      [T, 2],
      [T + 1000, 3],
    ]);
  });

  it("keeps the later of two prices in the same millisecond, and models sorted by key", () => {
    const a = row(`[cost]\ninput = 1\noutput = 2`);
    const b = row(`[cost]\ninput = 5\noutput = 6`);
    const c = row(`[cost]\ninput = 7\noutput = 8`);
    const folded = foldHistory([
      { key: "z/model", from: T, name: null, row: a },
      { key: "a/model", from: T, name: null, row: a },
      { key: "z/model", from: T + 1, name: null, row: b },
      { key: "z/model", from: T + 1, name: null, row: c },
      { key: "a/model", from: T + 1, name: null, row: b },
      { key: "a/model", from: T + 1, name: null, row: a },
    ]);
    expect(Object.keys(folded)).toEqual(["a/model", "z/model"]);
    expect(folded["z/model"].map((entry) => [entry.from, entry.input])).toEqual([[T, 1], [T + 1, 7]]);
    expect(folded["a/model"].map((entry) => [entry.from, entry.input])).toEqual([[T, 1]]);
  });
});

describe("correctHistory", () => {
  const priced = (/** @type {number} */ input) => row(`name = "M"\n[cost]\ninput = ${input}\noutput = 15\n`);
  const line = ["c1", "c2", "c3", "c4"];
  const revisions = [
    { key: "a/m", commit: "c1", row: priced(3) },
    { key: "a/m", commit: "c2", row: priced(4) },
    { key: "b/m", commit: "c3", row: priced(9) },
    { key: "a/m", commit: "c3", row: priced(3) },
    { key: "a/m", commit: "c4", row: priced(4) },
  ];
  const fix = { model: "a/m", from: "c3", until: "c4", why: "a sync restored the old price" };

  it("reads a corrected span of one model with the price its fix brought", () => {
    const inputs = correctHistory(revisions, line, [fix]).map((revision) => [revision.key, revision.commit, revision.row.input]);
    expect(inputs).toEqual([
      ["a/m", "c1", 3],
      ["a/m", "c2", 4],
      ["b/m", "c3", 9],
      ["a/m", "c3", 4],
      ["a/m", "c4", 4],
    ]);
  });

  it("fails on a correction that no longer fits the history", () => {
    expect(() => correctHistory(revisions, line, [{ ...fix, from: "gone" }])).toThrow(/gone is not on the published line/);
    expect(() => correctHistory(revisions, line, [{ ...fix, from: "c4", until: "c3" }])).toThrow(/c4 is not before c3/);
    expect(() => correctHistory(revisions, line, [{ ...fix, from: "c1", until: "c3", model: "b/m" }])).not.toThrow();
    expect(() => correctHistory(revisions, line, [{ ...fix, model: "b/m", from: "c1", until: "c2" }])).toThrow(
      /c2 brought it no price/,
    );
  });

  it("reads the shipped corrections, each naming a model and two commits", () => {
    const corrections = readCorrections();
    expect(corrections.length).toBeGreaterThan(0);
    for (const correction of corrections) {
      expect(correction.model).toMatch(/^[^/]+\/.+$/);
      expect(correction.from).toMatch(/^[0-9a-f]{40}$/);
      expect(correction.until).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("buildSeed", () => {
  /** @type {string[]} */
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @param {string} dir
   * @param {string[]} args
   * @param {number} [time] the commit's time, unix seconds
   */
  const git = (dir, args, time) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: dir,
      env: { ...process.env, ...(time === undefined ? {} : { GIT_AUTHOR_DATE: `@${time} +0000`, GIT_COMMITTER_DATE: `@${time} +0000` }) },
    });

  /**
   * @param {string} dir
   * @param {number} time
   * @param {{ files?: Record<string, string>, links?: Record<string, string>, remove?: string[] }} change
   */
  const commit = (dir, time, { files = {}, links = {}, remove = [] }) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    for (const [path, target] of Object.entries(links)) symlinkSync(target, join(dir, path));
    for (const path of remove) rmSync(join(dir, path));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `at ${time}`], time);
  };

  const S = 1_700_000_000;
  const priced = (/** @type {number} */ input) => `name = "Claude X"\n[cost]\ninput = ${input}\noutput = 15\n`;
  const pricedV2 = (/** @type {number} */ input) =>
    `schema = 2\nname = "Claude X"\n[cost.text.input]\nprice = ${input}\n[cost.text.output]\nprice = 15\n`;

  it("reads the first-parent history of the makers' files, aliases resolved", () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-prices-"));
    dirs.push(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    const model = "providers/anthropic/models/claude-x.toml";
    const alias = "providers/anthropic/models/claude-x-latest.toml";
    commit(dir, S + 1, {
      files: {
        [model]: priced(3),
        "providers/not-a-maker/models/claude-x.toml": priced(1),
        "providers/alibaba-cn/models/kimi/kimi-k9.toml": `name = "Kimi K9"\n[cost]\ninput = 1\noutput = 2\n`,
      },
      links: { [alias]: "claude-x.toml" },
    });
    commit(dir, S + 2, { files: { [model]: pricedV2(3) } }); // representation only
    // A price raised on a side branch reaches the published line with its merge.
    git(dir, ["checkout", "-q", "-b", "side"]);
    commit(dir, S + 3, { files: { [model]: pricedV2(4) } });
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--no-ff", "-m", "merge side", "side"], S + 4);
    commit(dir, S + 5, { files: { [model]: `schema = 2\nname = "Claude X"\n[cost.text.input]\nprice = 4\n` } });
    commit(dir, S + 6, { remove: [alias] });
    commit(dir, S + 7, { files: { [alias]: priced(4) } }); // re-added: continues its entries

    const { seed, skipped } = buildSeed(dir, ["anthropic", "alibaba-cn"]);
    const prices = Object.fromEntries(
      Object.entries(seed.models).map(([key, entries]) => [key, entries.map((entry) => [entry.from / 1000 - S, entry.input])]),
    );
    expect(prices).toEqual({
      "alibaba-cn/kimi/kimi-k9": [[1, 1]],
      "anthropic/claude-x": [[1, 3], [4, 4]],
      "anthropic/claude-x-latest": [[1, 3], [4, 4]],
    });
    expect(seed.commit).toBe(git(dir, ["rev-parse", "HEAD"]).toString().trim());
    expect(seed.models["anthropic/claude-x"][0]).toMatchObject({ name: "Claude X", output: 15, tiers: [], modes: {} });
    // The model and its alias both lost their output at S+5.
    expect(skipped.get(NO_TEXT_PRICE)?.revisions).toBe(2);
    expect(JSON.parse(formatSeed(seed))).toEqual(seed);
  });

  it("names who made each model as its latest revision did, and how far its history reaches", () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-prices-"));
    dirs.push(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    const based = (/** @type {string} */ base) => priced(1).replace("[cost]", `base_model = "${base}"\n[cost]`);
    commit(dir, S + 1, {
      files: {
        "providers/alibaba/models/deepseek-v4.1-flash.toml": priced(3),
        "providers/alibaba/models/qwen-x.toml": based("alibaba/qwen-x"),
        "providers/anthropic/models/claude-x.toml": priced(3),
      },
    });
    // A resold model names its maker only from a later revision on.
    commit(dir, S + 2, { files: { "providers/alibaba/models/deepseek-v4.1-flash.toml": based("deepseek/deepseek-v4.1-flash") } });
    commit(dir, S + 3, { files: { "README.md": "not a model" } });

    const { seed } = buildSeed(dir, ["alibaba", "anthropic"]);
    expect(seed.bases).toEqual({
      "alibaba/deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
      "alibaba/qwen-x": "alibaba/qwen-x",
    });
    expect(Object.keys(seed.models)).toContain("alibaba/deepseek-v4.1-flash");
    expect(seed.committedAt).toBe((S + 3) * 1000);
    expect(JSON.parse(formatSeed(seed))).toEqual(seed);
  });

  it("folds a span models.dev fixed later into the fix, a real change staying history", () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-prices-"));
    dirs.push(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    const model = "providers/anthropic/models/claude-x.toml";
    const head = () => git(dir, ["rev-parse", "HEAD"]).toString().trim();
    commit(dir, S + 1, { files: { [model]: priced(3) } });
    commit(dir, S + 2, { files: { [model]: priced(4) } }); // a real price change
    commit(dir, S + 3, { files: { [model]: priced(3) } }); // a sync copies the old price back
    const wrong = head();
    commit(dir, S + 4, { files: { [model]: priced(4) } }); // and the next one restores it
    const fixed = head();
    const inputs = (/** @type {import("./price-history.mjs").Seed} */ seed) =>
      seed.models["anthropic/claude-x"].map((entry) => [entry.from / 1000 - S, entry.input]);

    expect(inputs(buildSeed(dir, ["anthropic"]).seed)).toEqual([[1, 3], [2, 4], [3, 3], [4, 4]]);
    const correction = { model: "anthropic/claude-x", from: wrong, until: fixed, why: "test" };
    expect(inputs(buildSeed(dir, ["anthropic"], [correction]).seed)).toEqual([[1, 3], [2, 4]]);
  });
});

describe("CLI", () => {
  it("needs --repo and knows no other flags but --out", () => {
    expect(parseArgs(["--repo", "/r", "--out", "/o.json"])).toEqual({ repo: "/r", out: "/o.json" });
    expect(() => parseArgs([])).toThrow(/--repo is required/);
    expect(() => parseArgs(["--repo", "/r", "--oops"])).toThrow(/unknown argument: --oops/);
  });

  it("reads the makers from resources/pricing/makers.json", () => {
    expect(readMakers()).toContain("anthropic");
  });
});
