// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { present } from "@keepdeck/plugin-api/testing";
import { Probe, agentRun, catalog, deck, ipc, plans, pty, resetPaneSpawnSpecs, restored, settle } from "./testSupport";

// A rejected boot resume and the registry's answers run on the host now
// (recovery.host.test.ts). What stays is a plan whose whole build failed:
// no real host failure reaches it yet — a plugin hook that throws falls
// back to the bare plan — so it is held here until the fakes go (step 9).
describe("agent orchestrator — a plan that failed to build", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({ exists: true, isWorktree: false, empty: false, branch: null });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("is built again on Retry, and its pane starts, with no process stopped on the way", async () => {
    // The plan's build fails, and the cache says so.
    plans.failed.add("pane-1");
    act(() => deck.hydrate(restored({})));
    await settle();
    act(() => plans.notify());
    expect(pty.acquired).toEqual([]);
    expect(agentRun.planFailed.has("pane-1")).toBe(true);

    const epoch = agentRun.epochs["pane-1"] ?? 0;
    act(() => agentRun.retryPlanBuild("pane-1"));
    await settle();
    expect(agentRun.planFailed.has("pane-1")).toBe(false);
    expect(agentRun.epochs["pane-1"] ?? 0).toBeGreaterThan(epoch);
    expect(pty.acquired.map((launch) => launch.paneId)).toEqual(["pane-1"]);
  });
});
