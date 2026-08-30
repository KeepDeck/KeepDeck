// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PathProbe } from "../domain/agents";
import type { GitPosition } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { createDeckStore } from "./deckStore";
import {
  closeMessageFor,
  useCloseFlow,
  type ClosingPaneFacts,
  type ClosingTarget,
} from "./useCloseFlow";
import type { SuspendOutcome } from "./suspendOutcome";
import type { CloseRequest } from "./agentOrchestrator";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The teardown, as this hook sees it: a request, recorded. What the close
 * then DOES — the token revocations, the reaping, the worktree removal and
 * their order — belongs to the orchestrator and is asserted there. This file
 * is about the CONFIRMATION: which panes, which directories, and whether the
 * user meant it. */
const closeAgents = vi.fn<(request: CloseRequest) => Promise<string[]>>(() =>
  Promise.resolve([]),
);
/** The registry ask, faked at the seam: most tests leave it answering
 * "none" per entry (an ordinary close — the warning must NOT appear), and
 * the background tests aim it per test. The REAL seam batches one query
 * per distinct agent; the fake mirrors its contract. */
const backgroundCarriers = vi.fn<
  (
    entries: { agentType: string; sessionId: string }[],
  ) => Promise<("background" | "none" | "unknown" | null)[]>
>(async (entries) => entries.map(() => "none"));

/** A controllable in-flight ask for the late-paint tests: the dialog opens
 * before `resolve` fires — exactly what the standing instant-open rule
 * demands of the first frame. */
function deferredCarriers() {
  let settled = false;
  let resolve!: (
    value: ("background" | "none" | "unknown" | null)[],
  ) => void;
  const promise = new Promise<("background" | "none" | "unknown" | null)[]>(
    (res) => {
      resolve = (value) => {
        settled = true;
        res(value);
      };
    },
  );
  return {
    promise: () => promise,
    settled: () => settled,
    resolve,
  };
}
/** The last close this test asked for. */
const requested = () => closeAgents.mock.calls[0][0];

const probes = vi.hoisted(() => ({
  probeWorktree: vi.fn<(path: string) => Promise<PathProbe>>(),
}));
vi.mock("../ipc/worktree", () => ({
  probeWorktree: probes.probeWorktree,
}));

/** A probe answer: the dir is there (a plain worktree) or it's gone. */
function probed(exists: boolean): PathProbe {
  return { exists, isWorktree: exists, empty: false, branch: null };
}

let deck: Deck;
let flow: ReturnType<typeof useCloseFlow>;
let runtimeHeads: Map<string, GitPosition>;
const suspendAgent = vi.fn<
  (wsId: string, paneId: string) => Promise<SuspendOutcome>
>(() => Promise.resolve("suspended"));

/** What the hook reported to the user this test, by heading. */
const errors: string[] = [];
const refusals: string[] = [];
/** The revive sweep's blocked verdicts, as the hook receives them. */
let blockedPanes: Record<string, string> = {};

/** The pane facts the open dialog froze — what it says and offers. */
const agentSnapshot = () => {
  const closing = flow.closing;
  if (closing?.kind !== "agent") throw new Error("no agent dialog is open");
  return closing.pane;
};

function Probe() {
  // Fresh per mount (a bare call would rebuild it on every render).
  const [store] = useState(createDeckStore);
  deck = useDeck(store);
  flow = useCloseFlow(deck, {
    onError: (message) => errors.push(message),
    onSuspendRefused: (message) => refusals.push(message),
    gitPositions: runtimeHeads,
    blockedPanes,
    suspendAgent,
    closeAgents,
    backgroundCarriers,
  });
  return null;
}

/** A workspace with two panes, one on its own worktree (a discard target),
 * plus any extra worktree panes a test needs. */
function seed(extra: { id: string; cwd: string; branch: string }[] = []) {
  act(() => {
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude" },
        { id: "pane-2", agentType: "claude", cwd: "/wt/2", branch: "kd/ws/2" },
        ...extra.map((p) => ({ ...p, agentType: "claude" })),
      ],
    });
  });
  return "ws-1";
}

/** Bind pane-1 to a session — the registry ask keys off the binding, and a
 * close of an unbound pane has nothing to ask about. */
function bindSession(sessionId = "s-1") {
  act(() =>
    deck.setPaneSession("ws-1", "pane-1", {
      id: sessionId,
      boundAt: "2026-08-16T00:00:00Z",
    }),
  );
}

describe("useCloseFlow", () => {
  let root: Root;

  beforeEach(() => {
    closeAgents.mockClear();
    suspendAgent.mockClear();
    backgroundCarriers.mockReset();
    backgroundCarriers.mockResolvedValue(["none"]);
    probes.probeWorktree.mockReset();
    probes.probeWorktree.mockResolvedValue(probed(true));
    runtimeHeads = new Map();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("closing an agent names exactly that pane", async () => {
    const wsId = seed();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    act(() => flow.confirmClose());
    expect(requested()).toEqual({
      kind: "agent",
      wsId,
      paneId: "pane-1",
      deleteWorktrees: false,
      worktrees: [],
    });
  });

  it("opens WITHOUT the registry: full base text while the ask is still in flight, and 'none' never changes a character", async () => {
    // The standing rule — dialog opens stay instant — plus the warning's
    // area held from widening: the registry's ~0.25s must gate nothing,
    // and its ordinary answer must not so much as re-render the sentence.
    const ask = deferredCarriers();
    backgroundCarriers.mockImplementationOnce(ask.promise);
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    // First frame: the dialog is HERE, its text full and meaningful, no
    // placeholder, no waiting state — the ask has not answered yet.
    expect(ask.settled()).toBe(false);
    expect(flow.closeMessage).toContain("Its terminal session will be ended.");
    expect(flow.closeMessage).not.toContain("background");

    const before = flow.closeMessage;
    await act(async () => ask.resolve(["none"]));
    expect(backgroundCarriers).toHaveBeenCalledWith([
      { agentType: "claude", sessionId: "s-1" },
    ]);
    expect(flow.closeMessage).toBe(before);
  });

  it("a background carrier PAINTS the warning line when the answer lands", async () => {
    const ask = deferredCarriers();
    backgroundCarriers.mockImplementationOnce(ask.promise);
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closeMessage).not.toContain("carried");
    await act(async () => ask.resolve(["background"]));
    expect(flow.closeMessage).toContain("carried by a background agent");
    expect(flow.closeMessage).toContain("not the work");
    // Stopping the work is not ours to do; the sentence says whose it is.
    expect(flow.closeMessage).toContain("agents screen");
    // The base sentence is still there — the line is ADDITIVE.
    expect(flow.closeMessage).toContain("Its terminal session will be ended.");
  });

  it("an unreachable registry warns too — skipping on a failed question returns the harm whole", async () => {
    backgroundCarriers.mockResolvedValueOnce(["unknown"]);
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closeMessage).toContain("may still be carried");
    expect(flow.closeMessage).toContain("could not be reached");
  });

  it("a REJECTED ask paints the cautious line — a broken registry is unknown, not none", async () => {
    backgroundCarriers.mockRejectedValueOnce(new Error("spawn failed"));
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closeMessage).toContain("may still be carried");
  });

  it("an agent with no live registry is never asked — no background mechanism to warn about", async () => {
    backgroundCarriers.mockResolvedValueOnce([null]);
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closeMessage).not.toContain("background");
  });

  it("a null answer (no capability to ask) keeps the sentence to the character — the none-guard's twin", async () => {
    // Two quiet branches after the fix: "none" (the registry CLAIMED not
    // carried) and null (nobody was asked — the agent has no background
    // mechanism). Both must hold the ordinary sentence exactly; if the
    // null branch ever regresses into an assertion ("none" painted as a
    // claim) or a stray line, it will surface here, not in whatever
    // future step makes the distinction load-bearing again. The twin of
    // the none-guard: pinned TO THE CHARACTER, not by substring.
    backgroundCarriers.mockResolvedValueOnce([null]);
    const wsId = seed();
    bindSession();
    const before = (() => {
      // The same dialog without any ask at all — the reference sentence.
      return "Its terminal session will be ended.\nSuspending stops the agent instead, keeping the pane and its session.";
    })();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closeMessage).toBe(before);
    expect(flow.closeMessage).not.toContain("background");
  });

  it("an answer arriving AFTER the dialog is gone paints nothing anywhere", async () => {
    // The classic of the late-paint pattern: cancel (or confirm) while the
    // ask is in flight, then let it land. Nothing may throw, and the next
    // dialog must open clean — no straggler line from a dead generation.
    const ask = deferredCarriers();
    backgroundCarriers.mockImplementationOnce(ask.promise);
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    act(() => flow.cancelClose());
    await act(async () => {
      ask.resolve(["background"]);
    });
    expect(flow.closing).toBeNull();
    expect(flow.closeMessage).toBe("");

    backgroundCarriers.mockResolvedValueOnce(["none"]);
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closeMessage).not.toContain("carried");
  });

  it("a pane with no session binding asks nothing and closes ordinarily", async () => {
    // No binding, no conversation to be carried: the ask is skipped, not
    // defaulted — and the sentence stays the plain one.
    const wsId = seed();
    act(() => deck.addAgentPane("ws-1", { id: "pane-3", agentType: "claude" }));
    await act(async () => flow.requestCloseAgent(wsId, "pane-3", "Agent 3"));
    expect(backgroundCarriers).not.toHaveBeenCalled();
    expect(flow.closeMessage).not.toContain("background");
  });

  it("offers to delete a worktree that is still being created", async () => {
    // A pane mid-create has no cwd, so `worktreeTargets` cannot describe it
    // and the checkbox was never rendered — the create then landed a
    // directory and branch that no surface would ever name again.
    act(() => {
      deck.createWorkspace({
        id: "ws-2",
        instance: createWorkspaceInstance(),
        name: "two",
        cwd: "/repo",
        worktreeBaseDir: "/wt",
        panes: [
          {
            id: "pane-9",
            agentType: "claude",
            provisioning: {
              repo: "/repo",
              path: "/wt/two-1",
              workspace: "two",
              index: 1,
            },
          },
        ],
      });
    });
    await act(async () => flow.requestCloseAgent("ws-2", "pane-9", "Agent 1"));

    // No target — there is no directory to name yet — but the offer stands.
    expect(flow.closing?.targets).toEqual([]);
    expect(flow.worktreeCount).toBe(1);

    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    // The decision travels; the list does not have to be complete, because
    // the close finishes it against the live deck.
    expect(requested()).toMatchObject({
      kind: "agent",
      paneId: "pane-9",
      deleteWorktrees: true,
    });
  });

  it("does not ask to delete an in-flight create the user left unticked", async () => {
    act(() => {
      deck.createWorkspace({
        id: "ws-2",
        instance: createWorkspaceInstance(),
        name: "two",
        cwd: "/repo",
        worktreeBaseDir: "/wt",
        panes: [
          {
            id: "pane-9",
            agentType: "claude",
            provisioning: {
              repo: "/repo",
              path: "/wt/two-1",
              workspace: "two",
              index: 1,
            },
          },
        ],
      });
    });
    await act(async () => flow.requestCloseAgent("ws-2", "pane-9", "Agent 1"));
    act(() => flow.confirmClose());

    expect(requested()).toMatchObject({ deleteWorktrees: false });
  });

  it("closing a workspace names the workspace, not its panes", async () => {
    // Which panes a workspace holds is a fact about the deck at the moment
    // the close runs — reading it here would be a second answer to it.
    const wsId = seed();
    // The dialog opens only after the worktree probe answers.
    await act(async () => flow.requestCloseWorkspace(wsId));
    act(() => flow.confirmClose());
    expect(requested()).toEqual({
      kind: "workspace",
      wsId,
      deleteWorktrees: false,
      worktrees: [],
    });
  });

  it("a workspace with NO carried pane keeps its sentence to the character", async () => {
    // The warning's area, workspace half: an all-ordinary workspace must
    // say exactly what it always said — one extra word would be noise on
    // every close, and a missing word is the harm itself.
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseWorkspace(wsId));
    // Two panes hold sessions by seed + binding here; the exact old text.
    expect(flow.closeMessage).toBe(
      "This ends 2 agents and their sessions.",
    );
  });

  it("a workspace with ONE carried pane warns — painted when the answer lands", async () => {
    // A workspace close is the gesture furthest from the individual pane;
    // a carried conversation in it survives exactly as it survives a
    // single pane's close, and the person must hear that up front.
    const ask = deferredCarriers();
    backgroundCarriers.mockImplementationOnce(ask.promise);
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).not.toContain("carried");
    await act(async () => ask.resolve(["none", "background"]));
    expect(flow.closeMessage).toContain(
      "At least one conversation is carried by a background agent",
    );
    expect(flow.closeMessage).toContain("not the work");
    // The ordinary sentence still carries its count.
    expect(flow.closeMessage).toContain("This ends 2 agents");
  });

  it("a workspace where any ask failed warns too — the asymmetry holds per pane", async () => {
    backgroundCarriers.mockResolvedValueOnce(["none", "unknown"]);
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toContain("may still be carried");
  });

  it("uses the observed current branch when discarding an owned worktree", async () => {
    runtimeHeads.set("/wt/2", { branch: "feature/current" });
    const wsId = seed();
    await act(async () => flow.requestCloseWorkspace(wsId));
    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    await act(async () => {});

    expect(requested().worktrees).toEqual([
      { repo: "/repo", path: "/wt/2", branch: "feature/current" },
    ]);
  });

  it("a gone worktree is not offered for deletion", async () => {
    probes.probeWorktree.mockResolvedValue(probed(false));
    const wsId = seed();
    await act(async () => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));

    expect(probes.probeWorktree).toHaveBeenCalledWith("/wt/2");
    expect(flow.closing).not.toBeNull();
    expect(flow.closing!.targets).toEqual([]);

    // Even a forced checkbox can't discard: the snapshot holds no targets.
    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    await act(async () => {});
    expect(requested().worktrees).toEqual([]);
  });

  it("a workspace close keeps only the worktrees that still exist", async () => {
    probes.probeWorktree.mockImplementation((path) =>
      Promise.resolve(probed(path !== "/wt/2")),
    );
    const wsId = seed([{ id: "pane-3", cwd: "/wt/3", branch: "kd/ws/3" }]);
    await act(async () => flow.requestCloseWorkspace(wsId));
    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    await act(async () => {});

    expect(requested().worktrees).toEqual([
      { repo: "/repo", path: "/wt/3", branch: "kd/ws/3" },
    ]);
  });

  it("an unanswerable probe keeps the delete offer", async () => {
    probes.probeWorktree.mockRejectedValue(new Error("ipc down"));
    const wsId = seed();
    await act(async () => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));

    expect(flow.closing!.targets).toEqual([
      { repo: "/repo", path: "/wt/2", branch: "kd/ws/2" },
    ]);
  });

  it("a newer close request wins over a slower probe", async () => {
    let answer!: (probe: PathProbe) => void;
    probes.probeWorktree.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const wsId = seed();
    // The worktree pane's request hangs on its probe... The plain pane's
    // request only owes the registry ask (a microtask), so it opens first.
    act(() => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closing).toMatchObject({ kind: "agent", paneId: "pane-1" });

    await act(async () => answer(probed(true)));
    expect(flow.closing).toMatchObject({ kind: "agent", paneId: "pane-1" });
  });

  it("cancel closes nothing", async () => {
    const wsId = seed();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    act(() => flow.cancelClose());
    expect(closeAgents).not.toHaveBeenCalled();
    expect(deck.workspaces[0].panes).toHaveLength(2);
  });

  describe("suspending instead of closing", () => {
    it("dismisses the dialog and delegates to suspend, closing nothing", async () => {
      const wsId = seed();
      await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
      expect(flow.canSuspendInstead).toBe(true);

      act(() => flow.suspendInstead());

      expect(suspendAgent).toHaveBeenCalledWith(wsId, "pane-1");
      expect(flow.closing).toBeNull();
      // The pane stays in the deck and its session is not torn down here —
      // that is the whole difference from confirming.
      expect(closeAgents).not.toHaveBeenCalled();
      expect(deck.workspaces[0].panes).toHaveLength(2);
    });

    it("refuses while the worktree delete is ticked — the two contradict", async () => {
      const wsId = seed();
      await act(async () => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));
      act(() => flow.setDeleteWorktree(true));

      act(() => flow.suspendInstead());

      // A suspended pane comes back to that worktree; honouring the delete
      // would destroy what it returns to, and ignoring the ticked box is worse.
      expect(suspendAgent).not.toHaveBeenCalled();
      expect(flow.closing).not.toBeNull();
      expect(closeAgents).not.toHaveBeenCalled();
    });

    it("is not offered for a workspace close — a different verb on a different object", async () => {
      const wsId = seed();
      // Awaited: the workspace's worktree pane makes this dialog probe first.
      await act(async () => flow.requestCloseWorkspace(wsId));
      expect(flow.canSuspendInstead).toBe(false);

      act(() => flow.suspendInstead());
      expect(suspendAgent).not.toHaveBeenCalled();
    });

    it("is not offered for a pane that cannot be suspended", () => {
      act(() => {
        deck.createWorkspace({
          id: "ws-remote",
          instance: createWorkspaceInstance(),
          name: "remote",
          cwd: "/repo",
          worktreeBaseDir: null,
          panes: [
            {
              id: "pane-r",
              agentType: "codex",
              remoteEndpoint: "ws://vps:4500",
            },
          ],
        });
      });
      act(() => flow.requestCloseAgent("ws-remote", "pane-r", "Remote"));

      expect(flow.canSuspendInstead).toBe(false);
    });
  });
});

describe("closing a pane that is already stopped", () => {
  let root: Root;

  beforeEach(() => {
    closeAgents.mockClear();
    suspendAgent.mockClear().mockResolvedValue("suspended");
    probes.probeWorktree.mockReset().mockResolvedValue(probed(true));
    errors.length = 0;
    refusals.length = 0;
    blockedPanes = {};
    runtimeHeads = new Map();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("reports it as stopped, and offers no suspend", async () => {
    const wsId = seed();
    act(() =>
      deck.suspendPane(wsId, "pane-1"),
    );
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));

    expect(agentSnapshot().stopped).toBe(true);
    expect(flow.canSuspendInstead).toBe(false);
  });

  it("does NOT call a rising pane stopped — it is about to run", async () => {
    // The dialog would otherwise say "it is stopped" about a pane that is
    // seconds from a live terminal, which is every pane just after launch.
    const wsId = seed();
    act(() => deck.suspendPane(wsId, "pane-1"));
    act(() => deck.requestPaneWake(wsId, "pane-1"));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));

    expect(agentSnapshot().stopped).toBe(false);
  });

  it("surfaces a refused suspend instead of swallowing it", async () => {
    // The dialog is already dismissed by then, so a silent refusal leaves the
    // user with a pane that neither closed nor stopped and no explanation.
    const wsId = seed();
    suspendAgent.mockResolvedValueOnce("remote");
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));

    await act(async () => flow.suspendInstead());

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("remote server");
    // Reported as a REFUSAL, not through the worktree-error channel: the two
    // reach the user as headed alerts, and "Worktree error" is a lie about a
    // suspend the flow declined.
    expect(errors).toEqual([]);
  });

  it("treats a pane stuck on a GONE folder as stopped, like every other surface", async () => {
    // Its tile is dimmed and its tray chip carries the stopped marker, but
    // the model still calls it `waking` — the block is the sweep's runtime
    // verdict. Without it the dialog promised to end a terminal session that
    // does not exist, and offered to suspend a pane with no process.
    blockedPanes = { "pane-1": "/gone/worktree" };
    const wsId = seed();
    // The state the sweep actually leaves behind: still marked as rising,
    // because only the runtime block says it will never get there.
    act(() => deck.suspendPane(wsId, "pane-1"));
    act(() => deck.requestPaneWake(wsId, "pane-1"));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));

    expect(agentSnapshot().stopped).toBe(true);
    expect(flow.canSuspendInstead).toBe(false);
    expect(flow.closeMessage).toBe("It is stopped; closing removes the pane.");
  });
});

describe("what the dialog promises is what confirming does", () => {
  let root: Root;

  beforeEach(() => {
    closeAgents.mockClear();
    suspendAgent.mockClear().mockResolvedValue("suspended");
    probes.probeWorktree.mockReset().mockResolvedValue(probed(true));
    errors.length = 0;
    refusals.length = 0;
    blockedPanes = {};
    runtimeHeads = new Map();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("never claims a worktree goes with the pane — the checkbox decides that", async () => {
    // The sentence used to read "the pane and its worktree go with it" for a
    // stopped pane that owned one. `confirmClose` deletes a worktree only
    // when the box below is ticked, and it is unticked on every open: the
    // dialog was describing an outcome the default path does not produce.
    const wsId = seed();
    act(() => deck.suspendPane(wsId, "pane-2"));
    await act(async () => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));

    expect(flow.closing!.targets).toHaveLength(1); // it does own one
    expect(flow.closeMessage).not.toContain("worktree");

    act(() => flow.confirmClose());
    await act(async () => {});
    expect(requested().worktrees).toEqual([]);
  });

  it("offers the alternative only when it is really on offer", async () => {
    const wsId = seed();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closeMessage).toContain("Its terminal session will be ended.");
    expect(flow.closeMessage).toContain("Suspending stops the agent instead");

    // A remote pane can't be suspended — the sentence must not offer it.
    // Seeded through the deck rather than mutated in place: reading a pane
    // object the reducer never produced would pass here and mean nothing.
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-remote",
        agentType: "claude",
        remoteEndpoint: "ws://vps:4500",
      }),
    );
    await act(async () => flow.requestCloseAgent(wsId, "pane-remote", "Remote"));
    expect(flow.canSuspendInstead).toBe(false);
    expect(flow.closeMessage).toBe("Its terminal session will be ended.");
  });

  it("keeps the offer it opened with, even if the pane changes under it", async () => {
    // The dialog is a snapshot; the offer was derived live. A pane whose
    // probe came back "folder gone" while the dialog was open dropped the
    // Suspend button out of the row, sliding the destructive Close into the
    // slot the pointer was already aimed at. The gesture must not move.
    const wsId = seed();
    // A pane on its way up: suspendable, and the one state a mid-dialog
    // probe result can flip.
    act(() => deck.suspendPane(wsId, "pane-1"));
    act(() => deck.requestPaneWake(wsId, "pane-1"));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.canSuspendInstead).toBe(true);

    // The sweep reports the folder gone while the dialog is up.
    blockedPanes = { "pane-1": "/gone/worktree" };
    act(() => root.render(createElement(Probe)));

    expect(flow.canSuspendInstead).toBe(true);
    // And taking it is still safe: the suspend flow re-checks and refuses,
    // where the refusal has somewhere to be said.
    suspendAgent.mockResolvedValueOnce("stopped");
    await act(async () => flow.suspendInstead());
    expect(refusals).toHaveLength(1);
  });

  it("describes ONE moment, even when the pane moves under the dialog", async () => {
    // The facts were split: `stopped`/`canSuspend` snapshotted, `rising` and
    // `provisioning` read live every render. A pane that stops while the
    // dialog is up then flips `rising` false while `stopped` stays stale, and
    // the sentence becomes "Its terminal session will be ended" for a pane
    // with no process — an answer neither an all-live nor an all-snapshot
    // rule would give.
    const wsId = seed();
    act(() => deck.suspendPane(wsId, "pane-1"));
    act(() => deck.requestPaneWake(wsId, "pane-1"));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    const opened = flow.closeMessage;
    expect(opened).toContain("It is starting up; closing removes the pane.");

    // The sweep's plan build fails and puts the pane back down.
    act(() => deck.failPaneWake(wsId, "pane-1"));
    expect(flow.closeMessage).toBe(opened);
    expect(flow.canSuspendInstead).toBe(true); // the row does not reshuffle
  });

  it("snapshots at OPEN, not at request — the probe runs in between", async () => {
    // `park` defers the dialog until the worktree probe answers, so facts
    // read before that call describe a pane the user never saw a dialog for.
    const wsId = seed();
    let release!: () => void;
    probes.probeWorktree.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(probed(true)))),
    );
    act(() => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));
    expect(flow.closing).toBeNull(); // still probing

    // The pane stops while the probe is out.
    act(() => deck.suspendPane(wsId, "pane-2"));
    await act(async () => release());

    expect(flow.closing).not.toBeNull();
    expect(flow.closeMessage).toBe("It is stopped; closing removes the pane.");
    expect(flow.canSuspendInstead).toBe(false);
  });

  it("does not count an agent that has not started yet", async () => {
    // The ordinary shape of a just-launched deck: panes come back `waking`
    // and the revive sweep has not reached them. They have no session, so a
    // close ends none — the same distinction the agent branch draws with "It
    // is starting up", missing from the branch that counts.
    const wsId = seed();
    act(() => deck.suspendPane(wsId, "pane-1"));
    act(() => deck.requestPaneWake(wsId, "pane-1"));
    act(() => deck.suspendPane(wsId, "pane-2"));
    act(() => deck.requestPaneWake(wsId, "pane-2"));

    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toBe("This ends no sessions; closing removes 2 agents.");
  });

  it("counts the agents a workspace close ends", async () => {
    const wsId = seed();
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toBe("This ends 2 agents and their sessions.");
  });

  it("does not count a stopped agent's session among the ones it ends", async () => {
    // The same lie `closingIsStopped` removed from the agent branch, still
    // being told one branch over: a suspended agent has no session left to
    // end, and a workspace of them ends none at all.
    const wsId = seed();
    act(() => deck.suspendPane(wsId, "pane-1"));
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toBe("This ends 1 agent and its session.");

    act(() => deck.suspendPane(wsId, "pane-2"));
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toBe("This ends no sessions; closing removes 2 agents.");
  });

  it("does not promise to end a session a pane never had", async () => {
    // A pane still creating its worktree has never run, and one on its way up
    // has not started yet. Neither has a terminal session to end, and the
    // second was being offered "keep its session" in the same breath.
    act(() => {
      deck.createWorkspace({
        id: "ws-2",
        instance: createWorkspaceInstance(),
        name: "ws2",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-9",
            agentType: "claude",
            provisioning: {
              repo: "/repo",
              path: "/wt/ws2-1",
              workspace: "ws2",
              index: 1,
            },
          },
        ],
      });
    });
    await act(async () => flow.requestCloseAgent("ws-2", "pane-9", "Agent 1"));
    expect(flow.closeMessage).toBe("Its worktree is still being created.");

    const wsId = seed();
    act(() => deck.suspendPane(wsId, "pane-1"));
    act(() => deck.requestPaneWake(wsId, "pane-1"));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closeMessage).toContain("It is starting up");
    expect(flow.closeMessage).not.toContain("will be ended");
  });
});

describe("closeMessageFor", () => {
  const agent = (
    pane: Partial<ClosingPaneFacts> = {},
    targets = 0,
  ): ClosingTarget => ({
    kind: "agent",
    wsId: "ws-1",
    paneId: "pane-1",
    label: "Agent 1",
    pane: {
      provisioning: false,
      rising: false,
      stopped: false,
      canSuspend: false,
      ...pane,
    },
    targets: Array.from({ length: targets }, (_, i) => ({
      repo: "/repo",
      path: `/wt/${i}`,
      branch: `kd/ws/${i}`,
    })),
    pendingPanes: [],
  });
  const workspace = (count: number): ClosingTarget => ({
    kind: "workspace",
    id: "ws-1",
    name: "ws",
    count,
    targets: [],
    pendingPanes: [],
  });

  it("says nothing without a target", () => {
    expect(closeMessageFor(null, 0)).toBe("");
  });

  it("describes what closing an AGENT does, per state", () => {
    // The four sentences this dialog can say about one pane, side by side —
    // three of them were wrong at some point, each caught only through the
    // whole hook.
    expect(closeMessageFor(agent(), 0)).toBe("Its terminal session will be ended.");
    expect(closeMessageFor(agent({ stopped: true }), 0)).toBe(
      "It is stopped; closing removes the pane.",
    );
    expect(closeMessageFor(agent({ rising: true }), 0)).toBe(
      "It is starting up; closing removes the pane.",
    );
    expect(closeMessageFor(agent({ provisioning: true }), 0)).toBe(
      "Its worktree is still being created.",
    );
  });

  it("never mentions a worktree the confirm would not delete", () => {
    // The default path keeps it — the checkbox owns that decision. The only
    // place a worktree may be named is the SUSPEND alternative, which keeps
    // it on purpose.
    expect(closeMessageFor(agent({}, 1), 0)).not.toContain("worktree");
    expect(closeMessageFor(agent({ stopped: true }, 1), 0)).not.toContain(
      "worktree",
    );
    expect(closeMessageFor(agent({ canSuspend: true }, 1), 0)).toContain(
      "keeping the pane, its worktree and its session",
    );
    // No worktree to keep: the sentence must not invent one.
    expect(closeMessageFor(agent({ canSuspend: true }, 0), 0)).toContain(
      "keeping the pane and its session",
    );
  });

  it("offers the alternative only alongside a session to keep", () => {
    // A stopped pane is exactly the one the suspend offer refuses, so these
    // two can never combine — pinned because the old inline version could
    // spell the combination and nothing said it was impossible.
    expect(
      closeMessageFor(agent({ stopped: true, canSuspend: true }), 0),
    ).not.toContain("Suspending");
  });

  it("counts only a workspace's agents that still hold a session", () => {
    expect(closeMessageFor(workspace(0), 0)).toBe("This workspace has no agents.");
    expect(closeMessageFor(workspace(3), 3)).toBe(
      "This ends 3 agents and their sessions.",
    );
    expect(closeMessageFor(workspace(2), 1)).toBe(
      "This ends 1 agent and its session.",
    );
    // None running says so in the one way that is true of every reason for
    // having no session — stopped, still rising, or mid-create.
    expect(closeMessageFor(workspace(2), 0)).toBe(
      "This ends no sessions; closing removes 2 agents.",
    );
    expect(closeMessageFor(workspace(1), 0)).toBe(
      "This ends no session; closing removes 1 agent.",
    );
  });
});
