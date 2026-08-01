import { describe, expect, it } from "vitest";
import { agentSeriesColors } from "./chartPalette";

describe("agentSeriesColors", () => {
  it("keeps built-in agents on their fixed slots", () => {
    const colors = agentSeriesColors(["claude", "codex", "kimi", "opencode"]);
    expect(colors.get("claude")).toBe("#3987e5");
    expect(colors.get("codex")).toBe("#d95926");
    expect(colors.get("kimi")).toBe("#199e70");
    expect(colors.get("opencode")).toBe("#c98500");
  });

  it("keys spare slots on the full roster, so a subset never repaints", () => {
    // Full roster: alpha and zeta both known → alpha=slot0, zeta=slot1.
    const full = agentSeriesColors(["alpha", "claude", "zeta"]);
    expect(full.get("alpha")).toBe("#d55181");
    expect(full.get("zeta")).toBe("#008300");

    // The invariant the period switch relies on: the SAME roster always
    // yields the same colors — callers pass the ledger roster, not the
    // period's subset, so zeta keeps its slot even when alpha is silent
    // in the selected period.
    const again = agentSeriesColors(["alpha", "claude", "zeta"]);
    expect(again.get("zeta")).toBe("#008300");
  });

  it("folds agents past the spare slots into gray", () => {
    const many = agentSeriesColors(["a1", "a2", "a3", "a4", "a5", "a6"]);
    expect(many.get("a5")).toBe("#596273");
    expect(many.get("a6")).toBe("#596273");
  });
});
