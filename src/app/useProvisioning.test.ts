// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  provisioning = useProvisioning(deck, []);
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
        viewByWs: {},
      }),
    );

    const result = create();

    expect(deck.workspaces.map((ws) => ws.id)).toEqual([maxId]);
    expect(result).toEqual({ ok: false, reason: "sequence-exhausted" });
  });
});
