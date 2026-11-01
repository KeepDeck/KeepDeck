import { describe, expect, it } from "vitest";
import { readNothing } from "./unread";

describe("readNothing", () => {
  it("is a reading that got no bytes of its session at all", () => {
    expect(readNothing({ shortfall: [{ kind: "bytes", size: 4_096, readBytes: 0 }] })).toBe(true);
  });

  it("is not a reading that got part of the way, or one with nothing missing", () => {
    expect(readNothing({ shortfall: [{ kind: "bytes", size: 4_096, readBytes: 512 }] })).toBe(false);
    expect(readNothing({ shortfall: [{ kind: "parts", unreadableParts: 3 }] })).toBe(false);
    expect(readNothing({})).toBe(false);
  });
});
