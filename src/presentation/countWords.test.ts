import { describe, expect, it } from "vitest";
import { badgeCount } from "./countWords";

describe("badgeCount", () => {
  it("spells a count out to two digits, and says 99+ past them", () => {
    expect(badgeCount(1)).toBe("1");
    expect(badgeCount(99)).toBe("99");
    expect(badgeCount(100)).toBe("99+");
    expect(badgeCount(1280)).toBe("99+");
  });
});
