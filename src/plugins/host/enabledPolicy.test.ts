import { describe, expect, it } from "vitest";
import { enabledByPolicy } from "./enabledPolicy";

describe("enabledByPolicy", () => {
  it("built-in cli agents are ON by default — the deck needs its agents", () => {
    expect(enabledByPolicy(undefined, "builtin", "cli")).toBe(true);
  });

  it("deck plugins and every external stay opt-in", () => {
    expect(enabledByPolicy(undefined, "builtin", "deck")).toBe(false);
    expect(enabledByPolicy(undefined, "external", "cli")).toBe(false);
    expect(enabledByPolicy(undefined, "external", "deck")).toBe(false);
  });

  it("an explicit stored choice always wins, both ways", () => {
    // Turning a cli agent OFF is respected across restarts…
    expect(enabledByPolicy(false, "builtin", "cli")).toBe(false);
    // …and a deliberately enabled deck plugin stays on.
    expect(enabledByPolicy(true, "builtin", "deck")).toBe(true);
  });
});
