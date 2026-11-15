import { describe, expect, it } from "vitest";
import type { ProviderCardView, ProviderWindowView } from "./providersView";
import { limitsGlanceView } from "./limitsGlanceView";

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

const windowView = (over: Partial<ProviderWindowView> = {}): ProviderWindowView => ({
  id: "w",
  label: "5h",
  percent: { text: "12% used" },
  expired: false,
  window: { usedPct: 12, resetsAt: NOW + 2 * HOUR + 30 * 60_000, windowMinutes: 300 },
  burn: null,
  stroke: "#000",
  edge: { text: "", level: null, atReset: false },
  caption: [{ lead: "", text: "resets in 2h 30m" }],
  ledger: null,
  sessions: [],
  ...over,
});
const card = (over: Partial<ProviderCardView> = {}): ProviderCardView => ({
  agent: "codex",
  updated: { text: "Updated 2m ago" },
  age: { text: "2m ago" },
  note: null,
  windows: [windowView()],
  ...over,
});
const COLORS = new Map([["codex", "#d95926"]]);

describe("the limits glance", () => {
  it("is one line per window: bar, percent and the time to reset, the provider named once", () => {
    const view = limitsGlanceView(
      { kind: "cards", title: "Providers", cards: [card({ windows: [windowView({ id: "a" }), windowView({ id: "b", label: "week" })] })] },
      NOW,
      COLORS,
    );
    expect(view.empty).toBeNull();
    expect(view.providers[0]?.color).toBe("#d95926");
    expect(view.providers[0]?.windows.map((w) => [w.agent, w.label, w.percent.text, w.reset])).toEqual([
      ["codex", "5h", "12% used", "2h 30m"],
      [null, "week", "12% used", "2h 30m"],
    ]);
  });

  it("speaks a forecast only when it warns", () => {
    const calm = windowView({ caption: [{ lead: "", text: "resets in 2h" }, { lead: " · ", text: "Won't hit the limit" }] });
    const warning = windowView({
      caption: [{ lead: "", text: "Will hit the limit in ~40m", className: "usage-level--critical" }, { lead: " · ", text: "resets in 2h" }],
    });
    const [provider] = limitsGlanceView({ kind: "cards", title: "", cards: [card({ windows: [calm, warning] })] }, NOW, COLORS).providers;
    expect(provider?.windows.map((w) => w.alarm)).toEqual([
      null,
      { text: "Will hit the limit in ~40m", className: "usage-level--critical" },
    ]);
  });

  it("says a reading is old only when it is old enough to doubt — as its age, under the provider's name", () => {
    const glance = (over: Partial<ProviderCardView>) => {
      const [provider] = limitsGlanceView({ kind: "cards", title: "", cards: [card(over)] }, NOW, COLORS).providers;
      return { line: provider?.age, cells: provider?.windows.map((w) => w.age) };
    };
    const old = { updated: { text: "Updated 3h ago", className: "usage-level--warn" }, age: { text: "3h ago", className: "usage-level--warn" } };
    expect(glance({})).toEqual({ line: null, cells: [null] });
    // One window: the age takes a short line of its own under the name.
    expect(glance(old)).toEqual({ line: old.age, cells: [null] });
    // More windows: it fills the empty name cell of the second line, once.
    const three = [windowView({ id: "a" }), windowView({ id: "b" }), windowView({ id: "c" })];
    expect(glance({ ...old, windows: three })).toEqual({ line: null, cells: [null, old.age, null] });
  });

  it("marks a window that has reset, and says so when no provider has reported", () => {
    const reset = windowView({ expired: true, window: { usedPct: 80, resetsAt: NOW - HOUR, windowMinutes: 300 } });
    expect(limitsGlanceView({ kind: "cards", title: "", cards: [card({ windows: [reset] })] }, NOW, COLORS).providers[0]?.windows[0]?.reset).toBe("reset");
    expect(limitsGlanceView({ kind: "empty", text: "x" }, NOW, COLORS)).toEqual({
      title: "Limits now",
      link: "Limits →",
      providers: [],
      empty: "No provider reports yet.",
    });
  });
});
