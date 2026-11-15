import { describe, expect, it } from "vitest";
import { readStyles } from "./testSupport";

/**
 * The Limits cards tone a line — a warning, a critical run-out, a stale
 * report's age — with the shared usage-level classes, which set only a
 * colour on one class. A neutral colour set on the toned element through a
 * longer selector outranks them, and a "Will hit the limit" warning then
 * renders grey (task-717). The neutral grey is the container's, inherited.
 */
describe("the Limits cards' toned lines", () => {
  const css = readStyles("stats-providers.css");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: (selector ?? "").trim(),
    body: body ?? "",
  }));

  it("set no colour on the small lines a tone class may carry", () => {
    const outranking = rules.filter(
      (rule) => /\.stats__(window|provider-head)\b[^,]*\bsmall\b/.test(rule.selector) && /(^|[;\s])color\s*:/.test(rule.body),
    );
    expect(outranking.map((rule) => rule.selector)).toEqual([]);
  });
});
