// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import type { PaneActivity } from "../domain/status";
import {
  createAgentStatusTracker,
  type AgentStatusTracker,
} from "./agentStatusTracker";
import { AppRuntimeProvider } from "./runtimeContext";
import type { AppRuntime } from "./runtime";
import { usePaneActivities } from "./usePaneActivities";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The seam between the live tracker and whatever draws from it.
 *
 * The maths on either side is pinned pure — the ladder in `domain/status`,
 * the rows in `presentation/railView` — so what is left to hold here is the
 * one thing neither can: that an edge landing reaches a render at all, and
 * that the snapshot keeps its identity when nothing lands, which is what
 * lets one subscription serve a whole list of workspaces holding lists of
 * teams without folding them again on every unrelated render.
 */
describe("usePaneActivities", () => {
  let host: HTMLElement;
  let root: Root;
  let statusTracker: AgentStatusTracker;
  let latest: ReadonlyMap<string, PaneActivity>;
  let renders = 0;

  function Probe() {
    latest = usePaneActivities();
    renders += 1;
    return null;
  }

  const render = () =>
    act(() =>
      root.render(
        createElement(
          AppRuntimeProvider,
          { runtime: { statusTracker } as unknown as AppRuntime },
          createElement(Probe),
        ),
      ),
    );

  const reportEdge = (paneId: string, edge: AgentStatusEvent) =>
    act(() => statusTracker.report(paneId, { agent: "claude", edge }));

  beforeEach(() => {
    renders = 0;
    statusTracker = createAgentStatusTracker();
    statusTracker.registerNormalizer(
      "claude",
      (payload) => (payload as { edge?: AgentStatusEvent }).edge ?? null,
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("re-renders with the pane an edge just spoke about", () => {
    expect(latest.get("pane-1")).toBeUndefined();
    reportEdge("pane-1", { kind: "turn-start", at: 1 });
    expect(latest.get("pane-1")?.state).toBe("working");
    reportEdge("pane-1", { kind: "turn-end", at: 2 });
    expect(latest.get("pane-1")?.state).toBe("done");
  });

  it("keeps the snapshot's identity while nothing lands", () => {
    reportEdge("pane-1", { kind: "turn-start", at: 1 });
    const before = latest;
    const rendersBefore = renders;
    render();
    expect(renders).toBeGreaterThan(rendersBefore);
    expect(latest).toBe(before);
  });
});
