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
  usageCapabilities: ["paneTelemetry", "accountLimits"],
};

const OPENCODE: AgentInfo = {
  ...CLAUDE,
  id: "opencode",
  label: "OpenCode",
  command: "opencode",
  usageCapabilities: ["paneTelemetry"],
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

const paneReport = (): { agent: string; result: NormalizedUsage } => ({
  agent: "claude",
  result: {
    account: null,
    pane: {
      agent: "claude",
      model: "Opus",
      context: { usedPct: 62 },
      costUsd: 4.128,
      totalTokens: { input: 15_500, output: 1200 },
      reportedAt: 0,
    },
  },
});

describe("UsageChips", () => {
  let root: Root;
  let host: HTMLElement;
  const openStats = vi.fn();

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
    openStats.mockReset();
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

  const render = (
    liveAgents: ReadonlySet<string> = new Set(),
    agents: AgentInfo[] = [CLAUDE],
  ) =>
    act(() =>
      root.render(
        createElement(UsageChips, { agents, liveAgents, onOpenStats: openStats }),
      ),
    );

  it("renders nothing without live agents or data", () => {
    render();
    expect(host.textContent).toBe("");
  });

  it("gives a live agent its chip immediately, waiting for data", () => {
    render(new Set(["claude"]));
    const chip = host.querySelector(".usage-chip")!;
    expect(chip.textContent).toContain("···");
    expect(chip.getAttribute("title")).toContain("waiting");
  });

  it("does not create an account chip for a live pane-only agent", () => {
    render(new Set(["opencode"]), [OPENCODE]);
    expect(host.querySelector(".usage-chip")).toBeNull();
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
    // Chips are numbers-only — fill bars belong to the panel.
    expect(chip.querySelector(".usage-bar")).toBeNull();
  });

  it("colors only at the thresholds", () => {
    reportUsage("pane-1", limitsReport(91), AT);
    render();
    expect(host.querySelector(".usage-level--critical")).not.toBeNull();
  });

  it("renders no chip for a paneless provider without a REPORTED account", () => {
    // Pane-only data (tokens/context) is not an account claim — without a
    // live pane the chip waits for windows.
    reportUsage("pane-1", paneReport(), AT);
    render();
    expect(host.querySelector(".usage-chip")).toBeNull();
  });

  it("keeps session tokens and cost out of the account-limits panel", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    reportUsage("pane-1", paneReport(), AT);
    render();
    act(() => {
      (host.querySelector(".usage-chip") as HTMLButtonElement).click();
    });
    const panel = host.querySelector("#usage-panel")!;
    expect(panel.textContent).not.toContain("Sessions");
    expect(panel.textContent).not.toContain("Opus");
    expect(panel.textContent).not.toContain("$4.13");
  });

  it("marks stale data instead of showing confident numbers", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    vi.setSystemTime(AT + 31 * 60_000);
    render();
    const chip = host.querySelector(".usage-chip")!;
    expect(chip.className).toContain("usage-chip--dim");
    expect(chip.querySelector(".usage-chip__stale")).not.toBeNull();
  });

  it("labels a balance row as an allowance, not an unknown reset", () => {
    reportUsage(
      "pane-1",
      {
        agent: "claude",
        result: {
          account: {
            kind: "reported",
            windows: [
              // A quota-style BALANCE: no duration, no reset instant.
              { usedPct: 1, resetsAt: null, windowMinutes: null, scope: "quota" },
              // A rolling window that just didn't share its reset.
              { usedPct: 10, resetsAt: null, windowMinutes: 300 },
            ],
            reportedAt: 0,
            sourcePaneId: "",
          },
          pane: null,
        },
      },
      AT,
    );
    render();
    act(() => {
      (host.querySelector(".usage-chip") as HTMLButtonElement).click();
    });
    const panel = host.querySelector("#usage-panel")!;
    expect(panel.textContent).toContain("plan allowance");
    expect(panel.textContent).toContain("reset unknown");
  });

  it("opens the panel with countdowns and flips the display setting", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    render();
    const chip = host.querySelector(".usage-chip")!;
    expect(chip.getAttribute("aria-controls")).toBe("usage-panel");
    act(() => {
      (chip as HTMLButtonElement).click();
    });
    const panel = host.querySelector("#usage-panel")!;
    expect(panel.textContent).toContain("Claude Code");
    expect(panel.textContent).toContain("Updated now");
    // The panel spells the window out; the abbreviation stays on the chip.
    expect(panel.textContent).toContain("week");
    expect(panel.textContent).toContain("resets in 2h 0m");
    expect(panel.querySelector(".usage-bar")).not.toBeNull();

    act(() => {
      (panel.querySelector(".usage-panel__toggle") as HTMLButtonElement).click();
    });
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      usageDisplay: "left",
    });
  });

  it("leaves account limits for the global usage statistics screen", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    render();
    act(() => {
      (host.querySelector(".usage-chip") as HTMLButtonElement).click();
    });

    const open = host.querySelector<HTMLButtonElement>(".usage-panel__stats")!;
    expect(open.textContent).toContain("Open usage statistics");
    act(() => open.click());

    expect(openStats).toHaveBeenCalledOnce();
    expect(host.querySelector("#usage-panel")).toBeNull();
  });
});
