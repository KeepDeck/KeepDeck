// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../domain/journal";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { createDeckStore } from "./deckStore";
import { useJournalResume, type JournalResumeApi } from "./useJournalResume";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const plans = vi.hoisted(() => {
  const specs = new Map<string, { resumeOf: string; resumeOrigin: string }>();
  return {
    specs,
    buildResumeSpec: vi.fn(
      async (
        _plugins: unknown,
        _agentType: string,
        facts: { paneId: string },
        _ctx: unknown,
        resumeId: string,
        origin: string,
      ) => {
        specs.set(facts.paneId, { resumeOf: resumeId, resumeOrigin: origin });
        return true;
      },
    ),
    dropPaneSpawnSpec: vi.fn((paneId: string) => specs.delete(paneId)),
    peekPaneSpawnSpec: (paneId: string) => specs.get(paneId),
  };
});
vi.mock("./spawnSpecs", () => plans);
vi.mock("./runtimeContext", () => ({
  useAppRuntime: () => ({ plugins: {} }),
}));

const CTX = { bridgeDir: "/bridge" };

const record = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    agent: "codex",
    sessionId: "s-1",
    cwd: "/repo/wt",
    branch: "kd/x/1",
    yolo: true,
    boundAt: "2026-07-18T10:00:00.000Z",
    state: "closed",
    endedAt: "2026-07-18T11:00:00.000Z",
    ...over,
  }) as SessionRecord;

let deck: Deck;
let api: JournalResumeApi;
/** The revive sweep's gone-directory verdicts, as the hook receives them. */
let blockedPanes: Record<string, string> = {};

function Probe() {
  // Fresh per mount (a bare call would rebuild it on every render).
  const [store] = useState(createDeckStore);
  deck = useDeck(store);
  api = useJournalResume(deck, CTX, blockedPanes);
  return null;
}

describe("useJournalResume", () => {
  let root: Root;

  beforeEach(() => {
    plans.specs.clear();
    plans.buildResumeSpec.mockClear();
    blockedPanes = {};
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => act(() => root.unmount()));

  const mount = async () => {
    await act(async () => root.render(createElement(Probe)));
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws-1",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [],
      }),
    );
  };

  it("mints a pane carrying the record's shape and a pre-claimed session", async () => {
    await mount();
    await act(async () => api.resume("ws-1", record()));

    const panes = deck.workspaces[0].panes;
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({
      agentType: "codex",
      cwd: "/repo/wt", // foreign dir → pinned (the session's worktree)
      branch: "kd/x/1",
      yolo: true,
      session: { id: "s-1" },
    });
    // The plan was built for that pane, as a manual-origin resume.
    expect(plans.buildResumeSpec).toHaveBeenCalledTimes(1);
    expect(plans.specs.get(panes[0].id)).toMatchObject({
      resumeOf: "s-1",
      resumeOrigin: "manual",
    });
    // The journal record flips back to live in the same transition.
    expect(deck.journal.records["ws-1"][0]).toMatchObject({
      sessionId: "s-1",
      state: "live",
      paneId: panes[0].id,
    });
  });

  it("a session cwd equal to the workspace cwd stays a plain pane", async () => {
    await mount();
    await act(async () =>
      api.resume("ws-1", record({ cwd: "/repo", branch: undefined })),
    );
    expect(deck.workspaces[0].panes[0].cwd).toBeUndefined();
  });

  it("an already-claimed session fails LOUDLY — an enabled button must not be dead", async () => {
    await mount();
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    await expect(
      act(async () => api.resume("ws-1", record())),
    ).rejects.toThrow("already running");
    expect(deck.workspaces[0].panes).toHaveLength(1);
    expect(plans.buildResumeSpec).not.toHaveBeenCalled();
  });

  it("points at the pane that HOLDS the session when that pane is stopped", async () => {
    // "Already running" would be false and useless: the pane is stopped, and
    // the thing to do is resume it there, where its card has the button.
    await mount();
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    act(() => deck.suspendPane("ws-1", "pane-77"));

    await expect(
      act(async () => api.resume("ws-1", record())),
    ).rejects.toThrow("stopped pane");
  });

  it("calls a claimant stuck on a gone folder stopped, not running", async () => {
    // Its marker still says `waking`; only the sweep's runtime verdict knows
    // it will never get there. Without that verdict this message sent the
    // user to look for a running agent that isn't.
    await mount();
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    act(() => deck.suspendPane("ws-1", "pane-77"));
    act(() => deck.requestPaneWake("ws-1", "pane-77"));
    blockedPanes = { "pane-77": "/gone/worktree" };
    await act(async () => root.render(createElement(Probe)));

    await expect(
      act(async () => api.resume("ws-1", record())),
    ).rejects.toThrow("stopped pane");
  });

  it("rejects — and mints no pane — when the plan cannot be prepared", async () => {
    plans.buildResumeSpec.mockResolvedValueOnce(false);
    await mount();
    await expect(
      act(async () => api.resume("ws-1", record())),
    ).rejects.toThrow("resume plan");
    expect(deck.workspaces[0].panes).toHaveLength(0);
  });

  it("a full workspace fails loudly instead of stranding the plan in a silent no-op", async () => {
    await mount();
    act(() => {
      for (let i = 0; i < 16; i++) {
        deck.addAgentPane("ws-1", { id: `p-${i}`, agentType: "claude" });
      }
    });
    await expect(
      act(async () => api.resume("ws-1", record())),
    ).rejects.toThrow("full");
    expect(deck.workspaces[0].panes).toHaveLength(16);
  });

  it("re-checks the claim after the async build — a concurrent binder wins", async () => {
    await mount();
    plans.buildResumeSpec.mockImplementationOnce(
      async (_p, _a, facts: { paneId: string }, _c, resumeId: string) => {
        // The session gets claimed DURING the build (e.g. a revive landed).
        act(() =>
          deck.addAgentPane("ws-1", {
            id: "pane-claimer",
            agentType: "claude",
            session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
          }),
        );
        plans.specs.set(facts.paneId, { resumeOf: resumeId, resumeOrigin: "manual" });
        return true;
      },
    );
    await act(async () => api.resume("ws-1", record()));
    // Only the claimer pane exists — no second pane bound to the session.
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-claimer"]);
  });

  it("drops the built plan when the workspace died during the build", async () => {
    await mount();
    plans.buildResumeSpec.mockImplementationOnce(
      async (_p, _a, facts: { paneId: string }, _c, resumeId: string) => {
        act(() => deck.closeWorkspace("ws-1"));
        plans.specs.set(facts.paneId, {
          resumeOf: resumeId,
          resumeOrigin: "manual",
        });
        return true;
      },
    );
    await act(async () => api.resume("ws-1", record()));
    expect(deck.workspaces).toHaveLength(0);
    expect(plans.specs.size).toBe(0); // the orphaned plan was dropped
  });

  it("a YOLO override arms the resumed pane even when the source was plain", async () => {
    await mount();
    await act(async () =>
      api.resume("ws-1", record({ yolo: false }), { yolo: true }),
    );
    expect(deck.workspaces[0].panes[0].yolo).toBe(true);
    // The override reaches the spawn plan's facts, not just the pane flag.
    expect(plans.buildResumeSpec.mock.calls[0][2]).toMatchObject({ yolo: true });
  });

  it("a YOLO override=false disarms a resume of a YOLO source session", async () => {
    await mount();
    await act(async () => api.resume("ws-1", record({ yolo: true }), { yolo: false }));
    expect(deck.workspaces[0].panes[0].yolo).toBeUndefined();
    expect(plans.buildResumeSpec.mock.calls[0][2]).toMatchObject({ yolo: false });
  });
});
