// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/settingsManager", () => ({
  updateSettings: vi.fn(),
  getSettings: () => null,
  subscribeSettings: () => () => {},
  initSettings: async () => {},
}));

import type { AgentInfo } from "../../domain/agents";
import type { AccountUsage } from "../../domain/usage";
import { accountWindowKeys } from "../../domain/usage/reportJournal";
import { UsagePanel } from "./UsagePanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const MIN = 60_000;
const agent = { id: "claude", label: "Claude" } as AgentInfo;
const window = { usedPct: 62, resetsAt: NOW + 155 * MIN, windowMinutes: 300 };
const account: AccountUsage = {
  kind: "reported",
  windows: [window],
  reportedAt: NOW,
  sourcePaneId: "pane-1",
};

let root: Root;
afterEach(() => act(() => root.unmount()));

function render(reportsByKey: ReadonlyMap<string, never[]> | Map<string, unknown>) {
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
        reportsByKey: reportsByKey as never,
        onOpenStats: vi.fn(),
        onClose: vi.fn(),
      }),
    ),
  );
  return host;
}

describe("UsagePanel", () => {
  it("swaps the reset caption for the run-out and draws the sparkline", () => {
    const keys = accountWindowKeys("claude", account.windows);
    const reports = [50.4, 53.3, 56.2, 59.1, 62].map((usedPct, index) => ({
      agent: "claude",
      windowMinutes: 300,
      usedPct,
      reportedAt: NOW - (4 - index) * 10 * MIN,
      resetsAt: window.resetsAt,
    }));
    const host = render(new Map([[keys.get(window)!.key, reports]]));

    // The next relevant event replaces the reset countdown, colored.
    expect(host.textContent).toContain("runs out in ~");
    expect(host.textContent).not.toContain("resets in");
    expect(host.querySelector("small.usage-level--warn")).not.toBeNull();
    expect(host.querySelector(".usage-burn--compact")).not.toBeNull();
  });

  it("keeps today's quiet row when the journal has no pace", () => {
    const host = render(new Map());
    expect(host.textContent).toContain("resets in 2h 35m");
    expect(host.textContent).not.toContain("runs out");
    expect(host.querySelector(".usage-burn--compact")).toBeNull();
  });
});
