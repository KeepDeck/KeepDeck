// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { present } from "@keepdeck/plugin-api/testing";
import {
  Probe,
  agentRun,
  catalog,
  createWorkspaceInstance,
  deck,
  emptyJournal,
  ipc,
  liveRegistry,
  plans,
  pty,
  resetPaneSpawnSpecs,
  restored,
  settle,
} from "./testSupport";
import type { DeckState } from "./testSupport";

/**
 * A boot resume its agent rejected: the process exited at once, having
 * reported nothing. The page asks the agent's session registry what became of
 * the conversation, and acts on its answer — the wiring main's restart tests
 * held, here on the real session registry.
 */
describe("agent orchestrator — a rejected boot resume", () => {
  let root: Root;

  const pane = () => deck.workspaces[0].panes[0];
  const launches = () => pty.acquired.filter((launch) => launch.paneId === "pane-1");
  const lastArgs = () => launches()[launches().length - 1]?.args;

  /** The boot resume ran; its process now dies silently. */
  async function rejected(): Promise<boolean> {
    act(() => pty.exit("pane-1", 1));
    let took = false;
    act(() => {
      took = agentRun.recoverRejectedResume("ws-1", "pane-1", 1);
    });
    await settle();
    return took;
  }

  beforeEach(async () => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({ exists: true, isWorktree: false, empty: false, branch: null });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    liveRegistry.answer = null;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  async function bootResumed(): Promise<void> {
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await settle();
    expect(lastArgs()).toEqual(["--resume", "s-1"]);
  }

  it("keeps the binding and offers the choice when the conversation is live in another process", async () => {
    await bootResumed();
    liveRegistry.answer = "live";
    expect(await rejected()).toBe(true);
    expect(agentRun.occupied["pane-1"]).toMatchObject({ registry: "live" });
    expect(pane().session?.id).toBe("s-1");
    expect(launches()).toHaveLength(1);
    expect(pty.state("pane-1").kind).toBe("exited");
  });

  it("keeps the binding just the same when the registry could not say", async () => {
    await bootResumed();
    liveRegistry.answer = "unknown";
    expect(await rejected()).toBe(true);
    expect(agentRun.occupied["pane-1"]).toMatchObject({ registry: "unknown" });
    expect(pane().session?.id).toBe("s-1");
    expect(launches()).toHaveLength(1);
  });

  it("retries the resume once, quietly and in place, when the registry says the session is free", async () => {
    await bootResumed();
    const epoch = agentRun.epochs["pane-1"] ?? 0;
    liveRegistry.answer = "absent";
    expect(await rejected()).toBe(true);
    expect(launches()).toHaveLength(2);
    expect(lastArgs()).toEqual(["--resume", "s-1"]);
    expect(agentRun.specs["pane-1"]).toMatchObject({ resumeRetry: true });
    expect(pane().session?.id).toBe("s-1");
    expect(agentRun.epochs["pane-1"] ?? 0).toBeGreaterThan(epoch);
    expect(pty.isLive("pane-1")).toBe(true);
  });

  it("starts fresh when the quiet retry dies silently too", async () => {
    await bootResumed();
    liveRegistry.answer = "absent";
    await rejected();
    expect(await rejected()).toBe(true);
    expect(pane().session).toBeUndefined();
    expect(launches()).toHaveLength(3);
    expect(lastArgs()).toEqual([]);
    expect(pty.isLive("pane-1")).toBe(true);
  });

  it("starts fresh at once when nothing can be asked", async () => {
    // No registry to ask is not the registry saying the session is free: no
    // quiet retry, the legacy fresh start.
    await bootResumed();
    liveRegistry.answer = null;
    expect(await rejected()).toBe(true);
    expect(pane().session).toBeUndefined();
    expect(launches()).toHaveLength(2);
    expect(lastArgs()).toEqual([]);
  });

  it("keeps its promise off screen: the pane comes back though its workspace is no longer the one open", async () => {
    const instance = createWorkspaceInstance();
    const two: DeckState = {
      ...restored({ session: { id: "s-1", boundAt: "t" } }),
      workspaces: [
        ...restored({ session: { id: "s-1", boundAt: "t" } }).workspaces,
        { id: "ws-2", instance, name: "two", cwd: "/two", worktreeBaseDir: null, panes: [] },
      ],
      activeId: "ws-1",
      journal: emptyJournal,
    };
    act(() => deck.hydrate(two));
    await settle();
    expect(lastArgs()).toEqual(["--resume", "s-1"]);
    act(() => deck.selectWorkspace("ws-2"));
    await settle();
    liveRegistry.answer = "absent";
    expect(await rejected()).toBe(true);
    expect(launches()).toHaveLength(2);
    expect(pty.isLive("pane-1")).toBe(true);
  });
});

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
