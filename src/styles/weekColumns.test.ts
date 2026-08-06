import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

/**
 * The Weeks table's columns must line up across rows — and nothing about
 * the markup makes that automatic.
 *
 * `.stats__table` is a plain box; every `.stats__week-row` inside it is its
 * own grid. So a content-sized track (`max-content`, `fit-content`, `auto`)
 * is not "hug the content" here, it is "let each row choose its own column
 * positions". It did: measured in a real engine, the token column started
 * at 380, 404, 407 and 449px on four rows of one table. The rows only ever
 * looked aligned because every label was a date range of the same width,
 * and naming the current week "This week" made the difference visible.
 *
 * A DOM cannot answer this — happy-dom lays nothing out and resolves no
 * grid — so the guard reads the rule as text.
 */

const weeks = readStyles("stats-weeks.css");

/** The width forms that resolve against a row's own content. */
const CONTENT_SIZED = /\b(?:max-content|min-content|fit-content|auto)\b/;

describe("the Weeks table's columns", () => {
  it("sizes every track but the bar to a fixed width", () => {
    const columns = ruleBody(weeks, ".stats__week-row")["grid-template-columns"];
    expect(columns).toBeDefined();
    // The bar is the one flexible track — it absorbs the slack so the
    // right-hand cluster keeps its position at every dialog width.
    const flexible = columns.match(/minmax\([^)]*\)/g) ?? [];
    expect(flexible).toHaveLength(1);
    expect(columns.replace(/minmax\([^)]*\)/g, "")).not.toMatch(CONTENT_SIZED);
  });

  it("keeps the narrow layout fixed too, where the model column drops out", () => {
    // Same rule, restated for ≤720px: five tracks instead of six, and the
    // label still fixed. This copy was the one left behind.
    const narrow = weeks.slice(weeks.indexOf("@media (max-width: 720px)"));
    const columns = ruleBody(narrow, ".stats__week-row")["grid-template-columns"];
    expect(columns).toBeDefined();
    expect(columns.replace(/minmax\([^)]*\)/g, "")).not.toMatch(CONTENT_SIZED);
  });

  it("gives the label room for the widest thing the formatter can produce", () => {
    // A week from a previous year carries its year — "Sep 8 – Sep 14 · 2025",
    // 127px at the row's font. The label is the row's identity, so it must
    // not be what ellipsizes when the column is too narrow for it.
    const columns = ruleBody(weeks, ".stats__week-row")["grid-template-columns"];
    const first = Number(/^(\d+)px/.exec(columns.trim())?.[1]);
    expect(first).toBeGreaterThanOrEqual(128);
  });
});
