// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import type { Workspace } from "../domain/deck";
import type { StatusFrame } from "../domain/status";
import {
  createAgentStatusTracker,
  type AgentStatusTracker,
} from "./agentStatusTracker";
import { AppRuntimeProvider } from "./runtimeContext";
import type { AppRuntime } from "./runtime";
import { useWorkspaceFrames } from "./useWorkspaceFrames";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workspaces = [
  { id: "ws-1", panes: [{ id: "pane-1" }, { id: "pane-2" }] },
  { id: "ws-2", panes: [{ id: "pane-3" }] },
  // A just-created workspace has no panes yet — the dot must still answer.
  { id: "ws-3", panes: [] },
] as unknown as Workspace[];

let latest: ReadonlyMap<string, StatusFrame>;
function Probe({ activeId }: { activeId: string }) {
  latest = useWorkspaceFrames(workspaces, activeId);
  return null;
}

describe("useWorkspaceFrames", () => {
  let host: HTMLElement;
  let root: Root;
  let statusTracker: AgentStatusTracker;

  const render = (activeId: string) =>
    act(() =>
      root.render(
        createElement(
          AppRuntimeProvider,
          { runtime: { statusTracker } as unknown as AppRuntime },
          createElement(Probe, { activeId }),
        ),
      ),
    );

  const reportEdge = (paneId: string, edge: AgentStatusEvent) =>
    act(() => statusTracker.report(paneId, { agent: "claude", edge }));

  beforeEach(() => {
    statusTracker = createAgentStatusTracker();
    statusTracker.registerNormalizer(
      "claude",
      (payload) => (payload as { edge?: AgentStatusEvent }).edge ?? null,
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("folds each workspace's panes and marks the active one selected", () => {
    render("ws-1");
    expect(latest.get("ws-1")).toBe("selected");
    expect(latest.get("ws-2")).toBe("none");
    expect(latest.get("ws-3")).toBe("none");
  });

  it("an empty ACTIVE workspace keeps its green dot", () => {
    render("ws-3");
    expect(latest.get("ws-3")).toBe("selected");
  });

  it("re-folds when an edge lands — attention pierces the active green", () => {
    render("ws-1");
    reportEdge("pane-2", {
      kind: "waiting",
      at: Date.now(),
      reason: "permission",
    });
    expect(latest.get("ws-1")).toBe("waiting");

    // A background workspace's finished pane earns the done dot.
    reportEdge("pane-3", { kind: "turn-end", at: Date.now() });
    expect(latest.get("ws-2")).toBe("done");
  });
});
