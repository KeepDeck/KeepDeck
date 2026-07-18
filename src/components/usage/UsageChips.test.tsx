// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedUsage } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../../domain/agents";
import {
  registerUsageNormalizer,
  reportUsage,
  resetUsageManager,
} from "../../app/usageManager";
import { UsageChips } from "./UsageChips";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const settingsMock = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  getSettings: () => null,
  subscribeSettings: () => () => {},
}));
vi.mock("../../app/settingsManager", () => settingsMock);

const CLAUDE: AgentInfo = {
  id: "claude",
  label: "Claude Code",
  command: "claude",
  supportsYolo: true,
  installed: true,
  path: null,
};

const AT = 1_738_400_000_000;

/** Payloads carry the pre-normalized result — the chips are under test,
 * not a plugin's parser (those are tested with their plugins). */
const limitsReport = (usedPct: number): { agent: string; result: NormalizedUsage } => ({
  agent: "claude",
  result: {
    account: {
      kind: "reported",
      windows: [
        { usedPct, resetsAt: AT + 2 * 3_600_000, windowMinutes: 300 },
        { usedPct: 13, resetsAt: AT + 100 * 3_600_000, windowMinutes: 10_080 },
      ],
      reportedAt: 0,
      sourcePaneId: "",
    },
    pane: null,
  },
});

const unavailableReport = (): { agent: string; result: NormalizedUsage } => ({
  agent: "claude",
  result: {
    account: { kind: "unavailable", reason: "api-key", reportedAt: 0 },
    pane: null,
  },
});

describe("UsageChips", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    resetUsageManager();
    // The echo normalizer: payloads carry their normalized result, stamped
    // with the report time like a real parser would.
    registerUsageNormalizer("claude", (payload, at) => {
      const { result } = payload as { result: NormalizedUsage };
      return {
        account: result.account ? { ...result.account, reportedAt: at } : null,
        pane: result.pane,
      };
    });
    settingsMock.updateSettings.mockReset();
    vi.setSystemTime(AT);
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetUsageManager();
    vi.useRealTimers();
  });

  const render = () =>
    act(() => root.render(createElement(UsageChips, { agents: [CLAUDE] })));

  it("renders nothing before the first report", () => {
    render();
    expect(host.textContent).toBe("");
  });

  it("shows both account windows, calm below the thresholds", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    render();
    const chip = host.querySelector(".usage-chip")!;
    expect(chip.textContent).toContain("5h");
    expect(chip.textContent).toContain("42%");
    expect(chip.textContent).toContain("wk");
    expect(chip.textContent).toContain("13%");
    expect(chip.querySelector(".usage-level--warn")).toBeNull();
    expect(chip.className).not.toContain("usage-chip--dim");
  });

  it("colors only at the thresholds", () => {
    reportUsage("pane-1", limitsReport(91), AT);
    render();
    expect(host.querySelector(".usage-level--critical")).not.toBeNull();
  });

  it("dims an API-key account to --", () => {
    reportUsage("pane-1", unavailableReport(), AT);
    render();
    const chip = host.querySelector(".usage-chip")!;
    expect(chip.className).toContain("usage-chip--dim");
    expect(chip.textContent).toContain("--");
  });

  it("marks stale data instead of showing confident numbers", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    vi.setSystemTime(AT + 31 * 60_000);
    render();
    const chip = host.querySelector(".usage-chip")!;
    expect(chip.className).toContain("usage-chip--dim");
    expect(chip.querySelector(".usage-chip__stale")).not.toBeNull();
  });

  it("opens the panel with countdowns and flips the display setting", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    render();
    act(() => {
      (host.querySelector(".usage-chip") as HTMLButtonElement).click();
    });
    const panel = host.querySelector(".usage-panel")!;
    expect(panel.textContent).toContain("Claude Code");
    expect(panel.textContent).toContain("Updated now");
    expect(panel.textContent).toContain("resets in 2h 0m");

    act(() => {
      (panel.querySelector(".usage-panel__toggle") as HTMLButtonElement).click();
    });
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      usageDisplay: "left",
    });
  });
});
