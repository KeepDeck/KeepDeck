// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../domain/journal";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
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

function Probe() {
  deck = useDeck();
  api = useJournalResume(deck, CTX);
  return null;
}

describe("useJournalResume", () => {
  let root: Root;

  beforeEach(() => {
    plans.specs.clear();
    plans.buildResumeSpec.mockClear();
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

  it("no-ops when some pane already holds the session", async () => {
    await mount();
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    await act(async () => api.resume("ws-1", record()));
    expect(deck.workspaces[0].panes).toHaveLength(1);
    expect(plans.buildResumeSpec).not.toHaveBeenCalled();
  });

  it("rejects — and mints no pane — when the plan cannot be prepared", async () => {
    plans.buildResumeSpec.mockResolvedValueOnce(false);
    await mount();
    await expect(
      act(async () => api.resume("ws-1", record())),
    ).rejects.toThrow("resume plan");
    expect(deck.workspaces[0].panes).toHaveLength(0);
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
});
