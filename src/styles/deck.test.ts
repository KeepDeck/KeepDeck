import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

const deck = readStyles("deck.css");

describe("the bar's team", () => {
  it("sheds the branch before the name when the window narrows", () => {
    // Identity first, qualifiers last. A chip does not yield (chip.css), so
    // while the branch is in the row the NAME absorbs every missing pixel.
    // The branch is also the copy the deck can spare: every pane header on
    // the stage works on it.
    const narrow = deck.indexOf("@media (max-width: 1100px)");
    expect(narrow, "the branch sheds at no width").toBeGreaterThan(-1);
    expect(ruleBody(deck, ".deck__team-branch", narrow).display).toBe("none");

    // The name has no such rung: it is what the bar exists to say.
    expect(ruleBody(deck, ".deck__team-name").display).toBeUndefined();
  });
});
