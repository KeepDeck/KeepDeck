import { describe, expect, it } from "vitest";
import { bestMatch } from "./fuzzy";

const NAMES = ["KeepDeck", "Website", "mnemo"];

describe("bestMatch", () => {
  it("matches exactly, case-insensitively", () => {
    expect(bestMatch(NAMES, "keepdeck")).toBe("KeepDeck");
    expect(bestMatch(NAMES, "Website")).toBe("Website");
  });

  it("matches across spacing — 'web site' is Website", () => {
    expect(bestMatch(NAMES, "web site")).toBe("Website");
  });

  it("tolerates spoken inflection as a prefix either way", () => {
    // "кипдеке"-style trailing inflection: spoken extends the name.
    expect(bestMatch(["kipdek"], "kipdeke")).toBe("kipdek");
    // Spoken cut short: name extends the spoken form.
    expect(bestMatch(NAMES, "keep")).toBe("KeepDeck");
  });

  it("refuses unknowns and weak matches", () => {
    expect(bestMatch(NAMES, "backend")).toBeNull();
    expect(bestMatch(NAMES, "")).toBeNull();
    expect(bestMatch([], "keepdeck")).toBeNull();
  });

  it("refuses a tie instead of picking one", () => {
    expect(bestMatch(["web one", "web two"], "web")).toBeNull();
  });
});
