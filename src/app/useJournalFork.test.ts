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
  provisionInto: vi.fn(() => ({
    onResolved: vi.fn(),
    onFailed: vi.fn(),
    onSetup: vi.fn(),
  })),
  runProvisioning: vi.fn((..._args: unknown[]) => Promise.resolve()),
  registerPostProvision: vi.fn(),
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
    plans.dropPaneSpawnSpec.mockClear();
    provisioning.runProvisioning.mockClear();
    provisioning.provisionInto.mockClear();
    provisioning.registerPostProvision.mockClear();
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

  it("worktree target: card first, registers a DEFERRED post-provision step (not up-front surgery)", async () => {
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
    // The marker the whole restart-safety fix hinges on: serialize drops it.
    expect(pane.provisioning?.fork).toBe(true);
    expect(pane.yolo).toBe(true);
    // Surgery is NOT run up front — the worktree does not exist yet. Instead a
    // post-provision step is registered and plain provisioning is kicked off
    // (which runs the step, on both create AND retry — see provisioning.test.ts).
    expect(plans.buildForkSpec).not.toHaveBeenCalled();
    expect(provisioning.registerPostProvision).toHaveBeenCalledTimes(1);
    expect(provisioning.registerPostProvision.mock.calls[0][0]).toBe(pane.id);
    expect(provisioning.runProvisioning).toHaveBeenCalledTimes(1);
    expect(provisioning.runProvisioning.mock.calls[0][0]).toEqual([pane]);

    // The registered step runs the surgery bound to the CREATED worktree's cwd —
    // deliberately DISTINCT from the requested path, proving it uses the
    // callback's worktree.cwd, not the stale target.path.
    const step = provisioning.registerPostProvision.mock.calls[0][1] as (
      wt: { cwd: string; branch: string },
    ) => Promise<void>;
    await step({ cwd: "/repo-wt/fork-1-created", branch: "fork/auth" });
    expect(plans.buildForkSpec.mock.calls[0][2]).toMatchObject({
      paneId: pane.id,
      cwd: "/repo-wt/fork-1-created",
    });
  });

  it("worktree target: the registered step THROWS when the surgery can't prepare", async () => {
    await mount();
    plans.buildForkSpec.mockResolvedValue(false);
    await act(async () =>
      api.fork("ws-1", record(), { kind: "worktree", path: "/repo-wt/f", branch: "fork/x" }),
    );
    const step = provisioning.registerPostProvision.mock.calls[0][1] as (
      wt: { cwd: string; branch: string },
    ) => Promise<void>;
    // provisionPane relies on the throw to roll back + fail the card (asserted in
    // provisioning.test.ts); here we just prove the step signals failure.
    await expect(step({ cwd: "/repo-wt/f", branch: "fork/x" })).rejects.toThrow(
      "Agent could not prepare a fork plan",
    );
  });

  it("worktree target: the step propagates the plugin's OWN diagnostic when surgery REJECTS", async () => {
    await mount();
    plans.buildForkSpec.mockRejectedValue(new Error("opencode fork: unexpected id layout"));
    await act(async () =>
      api.fork("ws-1", record(), { kind: "worktree", path: "/repo-wt/f", branch: "fork/x" }),
    );
    const step = provisioning.registerPostProvision.mock.calls[0][1] as (
      wt: { cwd: string; branch: string },
    ) => Promise<void>;
    // A rejecting surgery propagates through the step (no masking try/catch), so
    // provisionPane surfaces the precise message, not the generic false one.
    await expect(step({ cwd: "/repo-wt/f", branch: "fork/x" })).rejects.toThrow(
      "unexpected id layout",
    );
  });

  it("a full workspace fails loudly — no stranded plan, no ownerless worktree", async () => {
    await mount();
    act(() => {
      for (let i = 0; i < 16; i++) {
        deck.addAgentPane("ws-1", { id: `p-${i}`, agentType: "claude" });
      }
    });
    await expect(
      act(async () =>
        api.fork("ws-1", record(), {
          kind: "worktree",
          path: "/repo-wt/f",
          branch: "fork/x",
        }),
      ),
    ).rejects.toThrow("full");
    expect(provisioning.runProvisioning).not.toHaveBeenCalled();
  });

  it("a full workspace fails a DIR fork BEFORE the irreversible surgery", async () => {
    await mount();
    act(() => {
      for (let i = 0; i < 16; i++) {
        deck.addAgentPane("ws-1", { id: `p-${i}`, agentType: "claude" });
      }
    });
    await expect(
      act(async () => api.fork("ws-1", record(), { kind: "dir", cwd: "/elsewhere" })),
    ).rejects.toThrow("full");
    // The early bail runs before forkSurgery — no export→rekey→import, no orphan.
    expect(plans.buildForkSpec).not.toHaveBeenCalled();
  });

  it("a throwing surgery propagates its precise diagnostic to the caller", async () => {
    plans.buildForkSpec.mockRejectedValueOnce(
      new Error("kimi fork of s-1: unexpected store layout"),
    );
    await mount();
    await expect(
      act(async () => api.fork("ws-1", record(), { kind: "dir", cwd: "/x" })),
    ).rejects.toThrow("unexpected store layout");
    expect(deck.workspaces[0].panes).toHaveLength(0);
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
