import { describe, expect, it } from "vitest";

import { MAX_ACTION_TITLE, actionTitle } from "./actionTitle";

describe("actionTitle", () => {
  it("passes a real label through untouched", () => {
    expect(actionTitle("topBarActions", "run", "Run task")).toBe("Run task");
  });

  it("refuses a title that would leave a button with no name", () => {
    // A blank title draws a button with no tooltip, no accessible name and no
    // glyph — and, now that the bar has a ceiling, one that takes a place away
    // from a contribution that does have something to say.
    for (const empty of ["", "   ", undefined, null, 7]) {
      expect(() => actionTitle("topBarActions", "ghost", empty)).toThrow(
        'contribution has no title: topBarActions "ghost"',
      );
    }
  });

  it("trims the outside off a title that does not know its room", () => {
    const long = "x".repeat(MAX_ACTION_TITLE + 40);
    const title = actionTitle("topBarActions", "long", long);
    expect(title).toHaveLength(MAX_ACTION_TITLE);
    expect(title.endsWith("…")).toBe(true);
  });

  it("keeps a title that ends exactly on the limit", () => {
    const exact = "y".repeat(MAX_ACTION_TITLE);
    expect(actionTitle("topBarActions", "exact", exact)).toBe(exact);
  });

  it("does not leave a space stranded before the ellipsis", () => {
    const title = actionTitle(
      "topBarActions",
      "spaced",
      `${"a".repeat(MAX_ACTION_TITLE - 1)} tail`,
    );
    expect(title).toBe(`${"a".repeat(MAX_ACTION_TITLE - 1)}…`);
  });

  it("takes the surrounding whitespace off before judging length", () => {
    expect(actionTitle("paneActions", "padded", "  Peek  ")).toBe("Peek");
  });

  it("never cuts a character in half", () => {
    // A JS string is UTF-16, so an emoji is TWO units: a `slice` at unit 59
    // can land between its halves and leave a lone surrogate, which the bar
    // draws as a replacement glyph — exactly where the title was trimmed to
    // look tidy. Counted in characters, the cut falls between them.
    const title = actionTitle(
      "topBarActions",
      "emoji",
      "🚀".repeat(MAX_ACTION_TITLE + 10),
    );
    expect(Array.from(title)).toHaveLength(MAX_ACTION_TITLE);
    // Whole rockets and an ellipsis — the exact match is what proves no half
    // of one is left stranded at the cut.
    expect(title).toBe(`${"🚀".repeat(MAX_ACTION_TITLE - 1)}…`);
  });

  it("counts what the reader sees, not what the string is stored in", () => {
    // Sixty emoji are sixty characters and a hundred and twenty units. Under
    // the old count they were trimmed at half the intended length.
    const exact = "🚀".repeat(MAX_ACTION_TITLE);
    expect(actionTitle("topBarActions", "exact-emoji", exact)).toBe(exact);
  });
});
