// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/useSettings", async () =>
  (await import("../../app/testing")).settingsHooksOver({ current: null }, vi.fn()),
);

import type { AgentInfo } from "../../domain/agents";
import type { AccountUsage } from "../../domain/usage";
import { accountWindowKeys, type WindowReport } from "../../domain/usage/reportJournal";
import { UsagePanel } from "./UsagePanel";
import { present } from "@keepdeck/plugin-api/testing";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const MIN = 60_000;
const agent: AgentInfo = { id: "claude", label: "Claude", command: "claude", features: [], installed: true, path: null };
const window = { usedPct: 62, resetsAt: NOW + 155 * MIN, windowMinutes: 300 };
const account: AccountUsage = {
  kind: "reported",
  windows: [window],
  reportedAt: NOW,
  sourcePaneId: "pane-1",
};

let root: Root;
afterEach(() => act(() => root.unmount()));

function render(reportsByKey: ReadonlyMap<string, readonly WindowReport[]>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(UsagePanel, {
        providers: [agent],
        openProvider: "claude",
        accounts: new Map([["claude", account]]),
        display: "used" as const,
        now: NOW,
        reportsByKey,
        seriesColors: new Map<string, string>(),
        onOpenStats: vi.fn(),
        onClose: vi.fn(),
      }),
    ),
  );
  return host;
}

describe("UsagePanel", () => {
  it("reads each DUPLICATED window's own history — the collision fix", () => {
    // Two duration-less windows: pre-fix both rows resolved one journal key.
    const twin = [
      { usedPct: 30, resetsAt: NOW + 100 * MIN, windowMinutes: null },
      { usedPct: 88, resetsAt: NOW + 900 * MIN, windowMinutes: null },
    ];
    const twinAccount: AccountUsage = {
      kind: "reported",
      windows: twin,
      reportedAt: NOW,
      sourcePaneId: "pane-1",
    };
    const keys = accountWindowKeys("claude", twin);
    // Only the SECOND window has a pace that loses the race.
    const reports = [70, 75, 80, 84, 88].map((usedPct, index): WindowReport => ({
      agent: "claude",
      windowMinutes: null,
      usedPct,
      reportedAt: NOW - (4 - index) * 10 * MIN,
      resetsAt: twin[1].resetsAt,
      ordinal: 1,
    }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(UsagePanel, {
          providers: [agent],
          openProvider: "claude",
          accounts: new Map([["claude", twinAccount]]),
          display: "used" as const,
          now: NOW,
          reportsByKey: new Map([[present(keys.get(twin[1]), "the key for twin[1]").key, reports]]),
          seriesColors: new Map<string, string>(),
          onOpenStats: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    );
    // Exactly one row adds the run-out; the 30% twin has its reset alone.
    expect(host.querySelectorAll("small.usage-level--critical")).toHaveLength(1);
    expect(host.textContent).toContain("hits the limit in ~");
    expect(host.textContent).toContain("resets in 1h 40m");
  });

  it("says the run-out ahead of the reset — never instead of it — and draws the sparkline", () => {
    const keys = accountWindowKeys("claude", account.windows);
    const reports = [50.4, 53.3, 56.2, 59.1, 62].map((usedPct, index): WindowReport => ({
      agent: "claude",
      windowMinutes: 300,
      usedPct,
      reportedAt: NOW - (4 - index) * 10 * MIN,
      resetsAt: window.resetsAt,
    }));
    const host = render(new Map([[present(keys.get(window), "the key for window").key, reports]]));

    // The run-out, coloured, then the reset: how long the wait is after it.
    const lines = [...host.querySelectorAll(".usage-window__lines small")];
    expect(lines.map((line) => line.textContent)).toEqual([expect.stringMatching(/^hits the limit in ~/), "resets in 2h 35m"]);
    expect(lines[0]?.className).toBe("usage-level--warn");
    expect(host.querySelector(".usage-burn--compact")).not.toBeNull();
  });

  it("keeps today's quiet row when the journal has no pace", () => {
    const host = render(new Map());
    expect(host.textContent).toContain("resets in 2h 35m");
    // Against the phrase the popover ACTUALLY prints. The old negative
    // named "runs out", which production stopped saying — so it was
    // permanently true and guarded nothing.
    expect(host.textContent).not.toContain("the limit");
    expect(host.querySelector(".usage-burn--compact")).toBeNull();
  });
});
