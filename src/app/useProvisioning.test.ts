// @vitest-environment happy-dom
import { emptyJournal } from "../domain/journal";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runs = vi.hoisted(() => ({
  runProvisioning: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));
vi.mock("./provisioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provisioning")>()),
  runProvisioning: runs.runProvisioning,
}));
import type { SpawnConfig } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { useProvisioning } from "./useProvisioning";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let deck: Deck;
let provisioning: ReturnType<typeof useProvisioning>;

function Probe() {
  deck = useDeck();
  provisioning = useProvisioning(deck);
  return null;
}

const config = (): SpawnConfig => ({
  name: "",
  cwd: "/repo",
  agentType: "claude",
  count: 0,
  worktreeBaseDir: null,
});

describe("useProvisioning workspace ids", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => act(() => root.unmount()));

  const create = () => {
    let result!: ReturnType<typeof provisioning.createWorkspace>;
    act(() => {
      result = provisioning.createWorkspace(config());
    });
    return result;
  };

  it("reuses the highest sequence after its workspace is deleted", () => {
    create();
    create();
    create();
    expect(deck.workspaces.map((ws) => [ws.id, ws.name])).toEqual([
      ["ws-1", "workspace-1"],
      ["ws-2", "workspace-2"],
      ["ws-3", "workspace-3"],
    ]);

    const oldInstance = deck.workspaces[2].instance;
    act(() => deck.closeWorkspace("ws-3"));
    create();

    expect(deck.workspaces.map((ws) => [ws.id, ws.name])).toEqual([
      ["ws-1", "workspace-1"],
      ["ws-2", "workspace-2"],
      ["ws-3", "workspace-3"],
    ]);
    expect(deck.workspaces[2].instance).not.toBe(oldInstance);
  });

  it("keeps advancing past the maximum when only an interior id is deleted", () => {
    create();
    create();
    create();

    act(() => deck.closeWorkspace("ws-2"));
    create();

    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-3", "ws-4"]);
  });

  it("allocates distinct ids to creates queued in the same React batch", () => {
    act(() => {
      provisioning.createWorkspace(config());
      provisioning.createWorkspace(config());
    });

    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-2"]);
  });

  it("can release and reuse the maximum inside one React batch", () => {
    create();
    create();
    create();

    act(() => {
      deck.closeWorkspace("ws-3");
      provisioning.createWorkspace(config());
    });

    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-2", "ws-3"]);
  });

  it("does not start a create when the numeric namespace is exhausted", () => {
    const maxId = `ws-${Number.MAX_SAFE_INTEGER}`;
    act(() =>
      deck.hydrate({
        workspaces: [
          {
            id: maxId,
            instance: createWorkspaceInstance(),
            name: "maximum",
            cwd: "/repo",
            worktreeBaseDir: null,
            panes: [],
          },
        ],
        activeId: maxId,
        journal: emptyJournal,
        viewByWs: {},
      }),
    );

    const result = create();

    expect(deck.workspaces.map((ws) => ws.id)).toEqual([maxId]);
    expect(result).toEqual({ ok: false, reason: "sequence-exhausted" });
  });
});

describe("useProvisioning retryPane", () => {
  let root: Root;
  beforeEach(() => {
    runs.runProvisioning.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const mountWith = async (provisioning: object) => {
    await act(async () => root.render(createElement(Probe)));
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws-1",
        cwd: "/repo",
        worktreeBaseDir: null,
        setup: "pnpm i",
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            provisioning: {
              repo: "/repo",
              workspace: "ws-1",
              index: 1,
              error: "boom",
              ...provisioning,
            },
          },
        ],
      }),
    );
  };

  it("re-runs setup ONLY for batch panes — a dialog/fork retry must not widen the attempt", async () => {
    // Dialog/fork intent: exact `path`, no baseDir → the initial run never
    // executed setup, so the retry must not either.
    await mountWith({ path: "/repo-wt/x", branch: "kd/x" });
    act(() => provisioning.retryPane("ws-1", "pane-1"));
    expect(runs.runProvisioning).toHaveBeenCalledTimes(1);
    expect(runs.runProvisioning.mock.calls[0][2]).toBeUndefined();
  });

  it("batch panes (runsSetup intent) keep their setup on retry", async () => {
    await mountWith({ baseDir: "/repo-wt", runsSetup: true });
    act(() => provisioning.retryPane("ws-1", "pane-1"));
    expect(runs.runProvisioning.mock.calls[0][2]).toBe("pnpm i");
  });

  it("an auto-placed pane WITHOUT the runsSetup stamp still skips setup on retry", async () => {
    // The discriminator is the explicit stamp, not baseDir's presence — a
    // future auto-placing dialog flow must not accidentally widen Retry.
    await mountWith({ baseDir: "/repo-wt" });
    act(() => provisioning.retryPane("ws-1", "pane-1"));
    expect(runs.runProvisioning.mock.calls[0][2]).toBeUndefined();
  });
});
