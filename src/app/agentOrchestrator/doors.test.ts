// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { present } from "@keepdeck/plugin-api/testing";
import {
  Probe,
  agentRun,
  buildResumeSpec,
  catalog,
  createWorkspaceInstance,
  deck,
  emptyJournal,
  ipc,
  machine,
  pty,
  resetPaneSpawnSpecs,
  settle,
} from "./testSupport";
import type { DeckState, PaneIdle } from "./testSupport";

/**
 * The doors' own rules — what each asks the machine, and what it does
 * besides — that main's restart and closing tests held and nothing on the
 * branch drove (audit task-878).
 */
describe("agent orchestrator — the doors", () => {
  let root: Root;
  const instance = createWorkspaceInstance();
  const ref = { id: "ws-1", instance };
  const pane = () => deck.workspaces[0].panes[0];
  const lastLaunch = () => pty.acquired[pty.acquired.length - 1];

  /** One agent bound to conversation s-1, up — or held down by `idle`. */
  const bound = (idle?: PaneIdle): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance,
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "claude", session: { id: "s-1", boundAt: "t" }, ...(idle && { idle }) }],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(buildResumeSpec).mockClear();
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

  it("forgets the conversation on a fresh restart, and starts the new process fresh", async () => {
    act(() => deck.hydrate(bound()));
    await settle();
    await act(async () => {
      await agentRun.restart("ws-1", "pane-1", "fresh");
    });
    await settle();
    expect(pane().session).toBeUndefined();
    expect(pty.acquired).toHaveLength(2);
    expect(lastLaunch()?.args).toEqual([]);
  });

  it("keeps the conversation on a restart that resumes, and resumes it in the new process", async () => {
    act(() => deck.hydrate(bound()));
    await settle();
    await act(async () => {
      await agentRun.restart("ws-1", "pane-1", "resume");
    });
    await settle();
    expect(pane().session?.id).toBe("s-1");
    expect(pty.acquired).toHaveLength(2);
    expect(lastLaunch()?.args).toEqual(["--resume", "s-1"]);
  });

  it("asks nothing for a reference that outlived its workspace — a slot used again since", async () => {
    act(() => deck.hydrate(bound()));
    await settle();
    const stale = { id: "ws-1", instance: createWorkspaceInstance() };
    const before = machine.intents.length;
    const answers = await Promise.all([
      agentRun.close({ kind: "workspace", workspace: stale, consent: { stops: [], folders: [], tickets: [] } }),
      agentRun.close({ kind: "agent", workspace: stale, paneId: "pane-1", consent: { stops: ["pane-1"], folders: [], tickets: [] } }),
      agentRun.archive(stale),
      agentRun.restore(stale),
    ]);
    for (const answer of answers) expect(answer).toEqual({ kind: "refused", refusal: { kind: "notFound" } });
    expect(machine.intents.slice(before)).toEqual([]);
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-1"]);
    // The workspace's own reference still reaches it.
    expect(await agentRun.archive(ref)).toMatchObject({ kind: "accepted" });
  });

  it("puts a pane back down and says why when the resume the person asked for cannot be built", async () => {
    act(() => deck.hydrate(bound({ reason: "suspended", at: "2026-11-20T00:00:00.000Z" })));
    await settle();
    vi.mocked(buildResumeSpec).mockRejectedValueOnce(new Error("the agent's plugin is gone"));
    await act(async () => {
      await agentRun.resume("ws-1", "pane-1");
    });
    await settle();
    // A resume the person asked for never comes up as another conversation:
    // no process, the pane down where it was, and its card says why.
    expect(pty.acquired).toEqual([]);
    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(agentRun.wakeFailed["pane-1"]).toContain("the agent's plugin is gone");
    expect(pane().session?.id).toBe("s-1");
  });
});
