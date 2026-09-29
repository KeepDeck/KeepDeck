import { describe, expect, it } from "vitest";
import type { AccountUsage } from "../domain/usage";
import { usageRingView } from "./usageRingView";

const NOW = 1_738_400_000_000;
const account = (five: number, week: number, reportedAt = NOW): AccountUsage => ({
  kind: "reported",
  windows: [
    { usedPct: five, resetsAt: NOW + 3_600_000, windowMinutes: 300 },
    { usedPct: week, resetsAt: NOW + 90 * 3_600_000, windowMinutes: 10_080 },
  ],
  reportedAt,
  sourcePaneId: "",
});

describe("usageRingView", () => {
  it("fills the ring to the tightest window and names every window in the hover", () => {
    const view = usageRingView("Claude Code", account(38, 61), NOW, "used");
    expect(view.fill).toBe(61);
    expect(view.window?.windowMinutes).toBe(10_080);
    expect(view.level).toBe("warn");
    expect(view.title).toBe("Claude Code · 5h 38% · wk 61%");
  });

  it("stays calm below the thresholds", () => {
    expect(usageRingView("Codex", account(9, 29), NOW, "used").level).toBeNull();
  });

  it("waits, empty, until the first report", () => {
    const view = usageRingView("Kimi", undefined, NOW, "used");
    expect(view).toMatchObject({ fill: 0, window: null, level: null, stale: false });
    expect(view.title).toBe("Kimi: waiting for the first report");
  });

  it("says when the numbers are old, and follows the display setting", () => {
    const old = usageRingView("Codex", account(9, 29, NOW - 3 * 3_600_000), NOW, "left");
    expect(old.stale).toBe(true);
    expect(old.title).toContain("showing data from");
    expect(old.title).toContain("wk 71% left");
  });

  it("goes critical at the red threshold and never fills past the ring", () => {
    const over = usageRingView("Claude Code", account(12, 130), NOW, "used");
    expect(over.fill).toBe(100);
    expect(over.level).toBe("critical");
  });

  it("shows the live window when the tighter one has already reset", () => {
    const reset: AccountUsage = {
      kind: "reported",
      windows: [
        { usedPct: 97, resetsAt: NOW - 1_000, windowMinutes: 300 },
        { usedPct: 85, resetsAt: NOW + 90 * 3_600_000, windowMinutes: 10_080 },
      ],
      reportedAt: NOW,
      sourcePaneId: "",
    };
    const view = usageRingView("Claude Code", reset, NOW, "used");
    expect(view.window?.windowMinutes).toBe(10_080);
    expect(view.fill).toBe(85);
    expect(view.level).toBe("critical");
  });

  it("is an empty ring for an account that reported no windows", () => {
    const empty: AccountUsage = { kind: "reported", windows: [], reportedAt: NOW, sourcePaneId: "" };
    expect(usageRingView("Codex", empty, NOW, "used")).toMatchObject({ fill: 0, window: null, level: null });
  });
});
