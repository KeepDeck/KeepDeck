import { describe, expect, it } from "vitest";
import { standingsOf } from "./standing";

describe("standingsOf", () => {
  it("names what a snapshot says about KeepDeck's work as a whole, and nothing when it works", () => {
    expect(standingsOf({ viewOnly: false, sessionsDown: false })).toEqual([]);
    expect(standingsOf({ viewOnly: true, sessionsDown: false })).toEqual(["viewOnly"]);
    expect(standingsOf({ viewOnly: false, sessionsDown: true })).toEqual(["sessionsDown"]);
    expect(standingsOf({ viewOnly: true, sessionsDown: true })).toEqual(["viewOnly", "sessionsDown"]);
  });
});
