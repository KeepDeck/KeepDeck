// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../domain/journal";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { useJournalFork, type JournalForkApi } from "./useJournalFork";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const plans = vi.hoisted(() => ({
  buildForkSpec: vi.fn(
    async (
      _plugins: unknown,
      _agentType: string,
      _facts: { paneId: string },
      _ctx: unknown,
      _fork: { sessionId: string },
    ) => true,
  ),
  dropPaneSpawnSpec: vi.fn(),
}));
vi.mock("./spawnSpecs", () => plans);
vi.mock("./runtimeContext", () => ({
  useAppRuntime: () => ({ plugins: {} }),
}));

const provisioning = vi.hoisted(() => ({
  provisionInto: vi.fn(() => ({}) as never),
  runProvisioning: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));
vi.mock("./provisioning", () => provisioning);

const CTX = { bridgeDir: "/bridge" };

const record = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    agent: "claude",
    sessionId: "s-1",
    cwd: "/old/wt",
    transcriptPath: "/t/s-1.jsonl",
    boundAt: "2026-07-18T10:00:00.000Z",
    state: "closed",
    endedAt: "2026-07-18T11:00:00.000Z",
    ...over,
  }) as SessionRecord;

let deck: Deck;
let api: JournalForkApi;

function Probe() {
  deck = useDeck();
  api = useJournalFork(deck, CTX);
  return null;
}

describe("useJournalFork", () => {
  let root: Root;

  beforeEach(() => {
    plans.buildForkSpec.mockClear();
    plans.buildForkSpec.mockResolvedValue(true);
    provisioning.runProvisioning.mockClear();
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

  it("dir target: mints an unbound pane in the chosen dir with the fork plan", async () => {
    await mount();
    await act(async () =>
      api.fork("ws-1", record(), { kind: "dir", cwd: "/elsewhere" }),
    );

    const pane = deck.workspaces[0].panes[0];
    expect(pane).toMatchObject({ agentType: "claude", cwd: "/elsewhere" });
    expect(pane.session).toBeUndefined(); // the fork's NEW id arrives via the reporter
    const call = plans.buildForkSpec.mock.calls[0];
    expect(call[2]).toMatchObject({ paneId: pane.id, cwd: "/elsewhere" });
    expect(call[4]).toEqual({
      sessionId: "s-1",
      sourceCwd: "/old/wt",
      transcriptPath: "/t/s-1.jsonl",
    });
  });

  it("the workspace's own folder stays a plain pane", async () => {
    await mount();
    await act(async () => api.fork("ws-1", record(), { kind: "dir", cwd: "/repo" }));
    expect(deck.workspaces[0].panes[0].cwd).toBeUndefined();
  });

  it("worktree target: provisioning card first, background create kicked off", async () => {
    await mount();
    await act(async () =>
      api.fork("ws-1", record({ yolo: true }), {
        kind: "worktree",
        path: "/repo-wt/fork-1",
        branch: "fork/auth",
      }),
    );

    const pane = deck.workspaces[0].panes[0];
    expect(pane.provisioning).toMatchObject({
      repo: "/repo",
      path: "/repo-wt/fork-1",
      branch: "fork/auth",
    });
    expect(pane.yolo).toBe(true);
    // The plan was built for the worktree's path BEFORE provisioning ran.
    expect(plans.buildForkSpec.mock.calls[0][2]).toMatchObject({
      cwd: "/repo-wt/fork-1",
    });
    expect(provisioning.runProvisioning).toHaveBeenCalledTimes(1);
    expect(provisioning.runProvisioning.mock.calls[0][0]).toEqual([pane]);
  });

  it("rejects — and mints nothing — when the fork plan (surgery) fails", async () => {
    plans.buildForkSpec.mockResolvedValueOnce(false);
    await mount();
    await expect(
      act(async () => api.fork("ws-1", record(), { kind: "dir", cwd: "/x" })),
    ).rejects.toThrow("fork plan");
    expect(deck.workspaces[0].panes).toHaveLength(0);
    expect(provisioning.runProvisioning).not.toHaveBeenCalled();
  });
});
