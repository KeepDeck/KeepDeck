import { describe, expect, it } from "vitest";
import { standingsOf } from "./standing";

describe("standingsOf", () => {
  it("says the sessions are down when the snapshot does, and nothing otherwise", () => {
    expect(standingsOf({ sessionsDown: false })).toEqual([]);
    expect(standingsOf({ sessionsDown: true })).toEqual(["sessionsDown"]);
  });
});
