// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedUsage } from "@keepdeck/plugin-api";
import {
  registerUsageNormalizer,
  reportUsage,
  resetUsageManager,
} from "./usageManager";
import { usePaneContextPct } from "./usePaneContextPct";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A one-line probe: renders the hook's value so the DOM reflects it. */
function Probe({ paneId }: { paneId: string }) {
  const pct = usePaneContextPct(paneId);
  return createElement("span", null, pct === undefined ? "—" : String(pct));
}

describe("usePaneContextPct", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    resetUsageManager();
    registerUsageNormalizer(
      "claude",
      (payload) => (payload as { result: NormalizedUsage }).result,
    );
    host = document.createElement("div");
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetUsageManager();
  });

  const report = (paneId: string, context: unknown) =>
    reportUsage(paneId, {
      agent: "claude",
      result: {
        account: null,
        pane: { agent: "claude", context, reportedAt: 0 },
      },
    });

  it("is undefined until the pane reports context", () => {
    act(() => root.render(createElement(Probe, { paneId: "p1" })));
    expect(host.textContent).toBe("—");
  });

  it("reflects the pane's context occupancy and tracks live changes", () => {
    report("p1", { usedPct: 40 });
    act(() => root.render(createElement(Probe, { paneId: "p1" })));
    expect(host.textContent).toBe("40");
    act(() => report("p1", { usedPct: 55 }));
    expect(host.textContent).toBe("55");
  });

  it("resolves a token-based context bag the same as the popover does", () => {
    report("p1", { usedTokens: 262_144, windowTokens: 1_048_576 });
    act(() => root.render(createElement(Probe, { paneId: "p1" })));
    expect(host.textContent).toBe("25");
  });

  it("is scoped to its own pane", () => {
    report("p2", { usedPct: 99 });
    act(() => root.render(createElement(Probe, { paneId: "p1" })));
    expect(host.textContent).toBe("—");
  });
});
