import { describe, expect, it, vi } from "vitest";
import type { DeckAction } from "../domain/deck/reducerActions";
import type { DeckStore } from "./deckStore";
import { deckStateOf } from "./deckStore.testSupport";
import type { PaneLifecycle } from "./paneLifecycle";
import type { PaneReportEvent } from "./verifiedPaneReports";

vi.mock("./spawnSpecs", () => ({ peekPaneSpawnSpec: () => ({ token: "tok" }) }));
vi.mock("./ptyManager", () => ({ paneSessionState: () => ({ kind: "live" }) }));
vi.mock("../ipc/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("../ipc/sessions", () => ({ onSessionUnbound: vi.fn() }));

import { createPaneAttribution } from "./paneAttribution";
import { listenPaneUnbinds } from "./paneUnbinding";

/** A deck with one local pane bound to `ses_a` and one remote pane, recording
 * what the lane dispatches. */
function deckWith() {
  const dispatched: DeckAction[] = [];
  const state = deckStateOf([
    { id: "pane-1", agentType: "opencode", session: { id: "ses_a", boundAt: "t" } },
    {
      id: "pane-2",
      agentType: "opencode",
      session: { id: "ses_r", boundAt: "t" },
      location: { kind: "remote", endpoint: "http://vps:4096" },
    },
    { id: "pane-3", agentType: "opencode" },
  ]);
  const deck: DeckStore = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    titleAgents: () => [],
    dispatch: (action) => {
      dispatched.push(action);
      return state;
    },
  };
  return { deck, dispatched };
}

async function lane() {
  const { deck, dispatched } = deckWith();
  const attribution = createPaneAttribution({
    workspaces: () => deck.getSnapshot().workspaces,
    secretOf: () => "tok",
  });
  for (const pane of ["pane-1", "pane-2", "pane-3"]) attribution.recordBinding(pane, "4021");
  const lifecycle: PaneLifecycle = { retire: vi.fn(), beginSession: vi.fn(), endSession: vi.fn() };
  let deliver!: (report: PaneReportEvent) => void;
  listenPaneUnbinds(deck, attribution, lifecycle, async (handler) => {
    deliver = handler;
    return () => {};
  });
  await Promise.resolve();
  return { deliver, dispatched, lifecycle };
}

const own = (paneId: string) => ({
  paneId,
  token: "tok",
  payload: { agent: "opencode", reporter: "4021" },
});

describe("listenPaneUnbinds", () => {
  it("forgets the pane's session and ends its telemetry when its own agent leaves it", async () => {
    // The user pressed /new and sent nothing yet: a restore now must start
    // fresh, not reopen the conversation they left.
    const { deliver, dispatched, lifecycle } = await lane();
    deliver(own("pane-1"));
    expect(dispatched).toEqual([{ type: "resetPaneSession", wsId: "ws-1", paneId: "pane-1" }]);
    expect(lifecycle.endSession).toHaveBeenCalledWith("pane-1");
  });

  it("ignores an unbinding from anyone but the pane's own agent process", async () => {
    for (const report of [
      { ...own("pane-1"), token: "stolen" },
      { ...own("pane-1"), payload: { agent: "opencode", reporter: "9999" } },
      { ...own("pane-1"), payload: { agent: "claude", reporter: "4021" } },
    ]) {
      const { deliver, dispatched, lifecycle } = await lane();
      deliver(report);
      expect(dispatched).toEqual([]);
      expect(lifecycle.endSession).not.toHaveBeenCalled();
    }
  });

  it("has nothing to forget for a remote pane, or one with no session", async () => {
    const { deliver, dispatched, lifecycle } = await lane();
    deliver(own("pane-2"));
    deliver(own("pane-3"));
    expect(dispatched).toEqual([]);
    expect(lifecycle.endSession).not.toHaveBeenCalled();
  });
});
