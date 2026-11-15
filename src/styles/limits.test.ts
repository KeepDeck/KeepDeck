import { describe, expect, it } from "vitest";
import { readStyles } from "./testSupport";

/**
 * The Limits cards tone a line — a warning, a critical run-out, a stale
 * report's age — with the shared usage-level classes, which set only a
 * colour on one class. A neutral colour set on the toned element through a
 * longer selector outranks them, and a "Will hit the limit" warning then
 * renders grey (task-717). The neutral grey is the container's, inherited.
 */
describe("toned limit lines", () => {
  const rules = (file: string) =>
    [...readStyles(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
      selector: (selector ?? "").trim(),
      body: body ?? "",
    }));
  const outranking = (file: string, owner: RegExp) =>
    rules(file)
      .filter((rule) => owner.test(rule.selector) && /(^|[;\s])color\s*:/.test(rule.body))
      .map((rule) => rule.selector);

  it("set no colour on the small lines a tone class may carry — on the Limits cards", () => {
    expect(outranking("stats-providers.css", /\.stats__(window|provider-head)\b[^,]*\bsmall\b/)).toEqual([]);
  });

  it("…and in the limits popover", () => {
    expect(outranking("usage.css", /\.usage-window__(lines|detail)\b[^,]*\bsmall\b/)).toEqual([]);
  });
});
