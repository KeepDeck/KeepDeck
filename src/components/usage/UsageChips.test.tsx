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

  const render = (
    paneNames: ReadonlyMap<string, string> = new Map(),
    liveAgents: ReadonlySet<string> = new Set(),
    agents: AgentInfo[] = [CLAUDE],
  ) =>
    act(() =>
      root.render(
        createElement(UsageChips, { agents, liveAgents, paneNames }),
      ),
    );

  it("renders nothing without live agents or data", () => {
    render();
    expect(host.textContent).toBe("");
  });

  it("gives a live agent its chip immediately, waiting for data", () => {
    render(new Map(), new Set(["claude"]));
    const chip = host.querySelector(".usage-chip")!;
    expect(chip.textContent).toContain("···");
    expect(chip.getAttribute("title")).toContain("waiting");
  });

  it("does not create an account chip for a live pane-only agent", () => {
    render(new Map(), new Set(["opencode"]), [OPENCODE]);
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

  it("lists live session rows in the panel", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    reportUsage("pane-1", paneReport(), AT);
    render(new Map([["pane-1", "auth-refactor"]]));
    act(() => {
      (host.querySelector(".usage-chip") as HTMLButtonElement).click();
    });
    const row = host.querySelector(".usage-session")!;
    expect(row.textContent).toContain("auth-refactor");
    expect(row.textContent).toContain("Opus");
    // Context% moved to the pane header — the popover row no longer carries it.
    expect(row.textContent).not.toContain("ctx");
    // In/out session tokens, compact.
    expect(row.textContent).toContain("↑15.5k");
    expect(row.textContent).toContain("↓1.2k");
    expect(row.textContent).toContain("$4.13");
  });

  it("omits the token line when a session reports no token totals", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    reportUsage(
      "pane-1",
      {
        agent: "claude",
        result: {
          account: null,
          pane: { agent: "claude", model: "Opus", costUsd: 1, reportedAt: 0 },
        },
      },
      AT,
    );
    render();
    act(() => {
      (host.querySelector(".usage-chip") as HTMLButtonElement).click();
    });
    const row = host.querySelector(".usage-session")!;
    expect(row.querySelector(".usage-session__tokens")).toBeNull();
    expect(row.textContent).toContain("$1.00");
  });

  it("shows only the token half a session actually reports", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    reportUsage(
      "pane-1",
      {
        agent: "claude",
        result: {
          account: null,
          pane: {
            agent: "claude",
            model: "Opus",
            totalTokens: { input: 15_500 }, // output unknown, not zero
            reportedAt: 0,
          },
        },
      },
      AT,
    );
    render();
    act(() => {
      (host.querySelector(".usage-chip") as HTMLButtonElement).click();
    });
    const row = host.querySelector(".usage-session")!;
    expect(row.textContent).toContain("↑15.5k");
    // The unknown output half is omitted, not shown as "↓0".
    expect(row.textContent).not.toContain("↓");
  });

  it("shows only the output half when input is absent", () => {
    reportUsage("pane-1", limitsReport(42), AT);
    reportUsage(
      "pane-1",
      {
        agent: "claude",
        result: {
          account: null,
          pane: {
            agent: "claude",
            model: "Opus",
            totalTokens: { output: 1200 }, // input unknown, not zero
            reportedAt: 0,
          },
        },
      },
      AT,
    );
    render();
    act(() => {
      (host.querySelector(".usage-chip") as HTMLButtonElement).click();
    });
    const row = host.querySelector(".usage-session")!;
    expect(row.textContent).toContain("↓1.2k");
    expect(row.textContent).not.toContain("↑");
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
});
