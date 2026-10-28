import { describe, expect, it } from "vitest";
import { usageEvent as event } from "../domain/usage/history/event.testSupport";
import { OVERFLOW_COLOR, SPARE_SLOTS, seriesColorFor, usageSeriesColors, type PaletteAgent } from "./usagePalette";

/** The built-in four, as their plugins declare them. */
const BUILT_INS: PaletteAgent[] = [
  { id: "claude", chartColor: "#3987e5" },
  { id: "codex", chartColor: "#d95926" },
  { id: "kimi", chartColor: "#199e70" },
  { id: "opencode", chartColor: "#c98500" },
];

const ledger = (...agents: string[]) => agents.map((agent) => event({ agent }));

describe("usageSeriesColors", () => {
  it("gives each installed agent the colour its plugin declares", () => {
    const colors = usageSeriesColors(ledger("claude", "codex"), BUILT_INS);
    expect(Object.fromEntries(colors)).toEqual({
      claude: "#3987e5",
      codex: "#d95926",
      kimi: "#199e70",
      opencode: "#c98500",
    });
  });

  it("gives an installed agent with no declared colour a spare slot by its rank in the catalog", () => {
    const catalog = [...BUILT_INS, { id: "zeta" }, { id: "alpha" }];
    const colors = usageSeriesColors(ledger("zeta"), catalog);
    expect(colors.get("alpha")).toBe(SPARE_SLOTS[0]);
    expect(colors.get("zeta")).toBe(SPARE_SLOTS[1]);
    // The ledger's period subset never repaints: the rank is the catalog's.
    expect(usageSeriesColors(ledger(), catalog).get("zeta")).toBe(SPARE_SLOTS[1]);
  });

  it("folds unhinted agents past the spare slots into gray", () => {
    const catalog = ["a1", "a2", "a3", "a4", "a5"].map((id) => ({ id }));
    expect(usageSeriesColors(ledger(), catalog).get("a5")).toBe(OVERFLOW_COLOR);
  });

  it("paints an agent whose plugin is disabled gray — its history stands, its colour does not", () => {
    const withoutKimi = BUILT_INS.filter((agent) => agent.id !== "kimi");
    const colors = usageSeriesColors(ledger("claude", "kimi"), withoutKimi);
    expect(colors.get("kimi")).toBe(OVERFLOW_COLOR);
    expect(colors.get("claude")).toBe("#3987e5");
  });

  it("answers gray for an id the map does not hold", () => {
    expect(seriesColorFor(new Map([["claude", "#3987e5"]]), "toString")).toBe(OVERFLOW_COLOR);
  });
});
