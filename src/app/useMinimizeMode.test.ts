import { describe, expect, it } from "vitest";
import { useMinimizeMode } from "./useMinimizeMode";

describe("useMinimizeMode", () => {
  it("enables manual minimizing only for Grid with a visible shelf", () => {
    expect(useMinimizeMode("grid", "tray")).toBe(true);
    expect(useMinimizeMode("grid", "strip")).toBe(true);
    expect(useMinimizeMode("grid", "none")).toBe(false);
    expect(useMinimizeMode("list", "tray")).toBe(false);
    expect(useMinimizeMode("list", "strip")).toBe(false);
  });
});
