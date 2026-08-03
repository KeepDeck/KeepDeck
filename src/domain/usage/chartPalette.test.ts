import { describe, expect, it } from "vitest";
import { ledgerSeriesColors } from "./chartPalette";
import { usageEvent as event } from "./history/event.testSupport";

/** The production door: colors derive from the LEDGER (one event per
 * agent suffices — the roster is who ever appears, alphabetical). */
const colorsOf = (...agents: string[]) =>
  ledgerSeriesColors(agents.map((agent) => event({ agent })));

describe("ledgerSeriesColors", () => {
  it("keeps built-in agents on their fixed slots", () => {
    const colors = colorsOf("claude", "codex", "kimi", "opencode");
    expect(colors.get("claude")).toBe("#3987e5");
    expect(colors.get("codex")).toBe("#d95926");
    expect(colors.get("kimi")).toBe("#199e70");
    expect(colors.get("opencode")).toBe("#c98500");
  });

  it("keys spare slots on the full roster, so a subset never repaints", () => {
    // Full roster: alpha and zeta both known → alpha=slot0, zeta=slot1.
    const full = colorsOf("alpha", "claude", "zeta");
    expect(full.get("alpha")).toBe("#d55181");
    expect(full.get("zeta")).toBe("#008300");

    // The invariant the period switch relies on: the SAME ledger always
    // yields the same colors — callers pass the ledger's events, not the
    // period's subset, so zeta keeps its slot even when alpha is silent
    // in the selected period.
    const again = colorsOf("alpha", "claude", "zeta");
    expect(again.get("zeta")).toBe("#008300");
  });

  it("folds agents past the spare slots into gray", () => {
    const many = colorsOf("a1", "a2", "a3", "a4", "a5", "a6");
    expect(many.get("a5")).toBe("#596273");
    expect(many.get("a6")).toBe("#596273");
  });
});
