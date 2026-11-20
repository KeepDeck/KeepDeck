// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsOut, findWorkspace, membersOf, teamsOf, type Pane, type Team, type Workspace } from "../domain/deck";
import type { IntentOutcome, SuspendResult } from "../domain/lifecycle";
import { createWorkspaceInstance, type WorkspaceRef } from "../domain/workspaceInstance";
import type { Intent } from "../ipc/generated/lifecycle/Intent";
import type { Preview } from "../ipc/generated/lifecycle/Preview";
import { intentOutcomeText, refusalText } from "../presentation/lifecycleWords";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { createDeckStore } from "./deckStore";
import { useCloseFlow } from "./useCloseFlow";
import type { CloseRequest } from "./agentOrchestrator";
import { present } from "@keepdeck/plugin-api/testing";

const ACCEPTED: IntentOutcome = { kind: "accepted", op: 1, minted: { workspace: null, team: null, panes: [] } };
/** The consent of a close that deletes nothing. */
const NOTHING = { folders: [], tickets: [] };

/** The teardown, as this hook sees it: a request, recorded. What the close
 * then DOES belongs to the lifecycle machine and is asserted there. This
 * file is about the CONFIRMATION: which panes, which offer, and whether the
 * user meant it. */
const closeAgents = vi.fn(async (_request: CloseRequest): Promise<IntentOutcome> => ACCEPTED);

/** The machine's offer for a team set, as it would make it from this deck:
 * every team's worktree but the root's, and a ticket per create still out. */
function offerOf(ws: Workspace, teams: readonly Team[]): Pick<Preview, "folders" | "creations"> {
  return {
    folders: teams.flatMap((team) =>
      team.location?.kind === "attached" && team.location.cwd !== ws.cwd
        ? [{ repo: ws.cwd, path: team.location.cwd, branch: team.location.branch ?? null }]
        : [],
    ),
    creations: teams.flatMap((team, at) => (createIsOut(team.location) ? [100 + at] : [])),
  };
}

/** `lifecycle_preview`, faked over the deck the hook reads. */
function machinePreview(intent: Intent): Preview {
  const ws = findWorkspace(deck.workspaces, intent.kind === "closeAgent" || intent.kind === "disband" || intent.kind === "closeWorkspace" ? intent.workspace : "");
  const none: Preview = { refusal: { kind: "notFound" }, stops: [], folders: [], creations: [], lastOf: null };
  if (!ws) return none;
  switch (intent.kind) {
    case "closeAgent": {
      const pane = ws.panes.find((candidate) => candidate.id === intent.pane);
      const teamId = pane?.team?.teamId;
      const team = teamId ? teamsOf(ws).find((candidate) => candidate.id === teamId) : undefined;
      const last = team && membersOf(ws, team.id).length === 1 ? team : undefined;
      return {
        refusal: null,
        stops: [intent.pane],
        folders: [],
        creations: [],
        lastOf: last ? [last.id, { refusal: null, stops: [intent.pane], ...offerOf(ws, [last]), lastOf: null }] : null,
      };
    }
    case "disband":
      return { refusal: null, stops: membersOf(ws, intent.team).map((pane) => pane.id), ...offerOf(ws, teamsOf(ws).filter((team) => team.id === intent.team)), lastOf: null };
    case "closeWorkspace":
      return { refusal: null, stops: ws.panes.map((pane) => pane.id), ...offerOf(ws, teamsOf(ws)), lastOf: null };
    default:
      return none;
  }
}
const preview = vi.fn(async (intent: Intent) => machinePreview(intent));
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

let deck: Deck;
let flow: ReturnType<typeof useCloseFlow>;
const suspendAgent = vi.fn(async (_wsId: string, _paneId: string): Promise<SuspendResult> => ({ kind: "suspending" }));

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
/** The last-member offer the open agent dialog carries. */
const lastOffer = () => {
  const closing = flow.closing;
  if (closing?.kind !== "agent") throw new Error("no agent dialog is open");
  if (!closing.last) throw new Error("the pane is not its team's last member");
  return closing.last;
};

function Probe() {
  // Fresh per mount (a bare call would rebuild it on every render).
  const [store] = useState(createDeckStore);
  deck = useDeck(store);
  flow = useCloseFlow(deck, {
    onError: (message) => errors.push(message),
    onSuspendRefused: (message) => refusals.push(message),
    preview,
    blockedPanes,
    suspendAgent,
    closeAgents,
    backgroundCarriers,
  });
  return null;
}

/** The live ref of ws-1. */
const ref = (): WorkspaceRef => {
  const ws = present(deck.workspaces.find((candidate) => candidate.id === "ws-1"), "the ws-1 workspace");
  return { id: ws.id, instance: ws.instance };
};

/**
 * A workspace with two teams: "root" on the repo root with two members
 * (pane-1 and its company pane-0), and "wt" on a worktree of its own with
 * pane-2 as its LAST member — the one pane whose close speaks two verbs.
 * Extra worktree teams, one member each, as a test needs.
 */
function seed(extra: { id: string; cwd: string; branch: string }[] = []) {
  act(() => {
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude", team: { teamId: "team-1", role: "lead" } },
        { id: "pane-0", agentType: "claude", team: { teamId: "team-1", role: "impl-1" } },
        { id: "pane-2", agentType: "claude", team: { teamId: "team-2", role: "lead" } },
        ...extra.map(
          (p, i): Pane => ({
            id: p.id,
            agentType: "claude",
            team: { teamId: `team-${i + 3}`, role: "lead" },
          }),
        ),
      ],
      teams: [
        { id: "team-1", name: "root", location: { kind: "attached", cwd: "/repo" } },
        { id: "team-2", name: "wt", location: { kind: "attached", cwd: "/wt/2", branch: "kd/ws/2" } },
        ...extra.map(
          (p, i): Team => ({
            id: `team-${i + 3}`,
            name: p.id,
            location: { kind: "attached", cwd: p.cwd, branch: p.branch },
          }),
        ),
      ],
    });
  });
  return "ws-1";
}

/** A second workspace whose one team is still creating its worktree, with
 * pane-9 as its only member. */
function creating() {
  act(() => {
    deck.createWorkspace({
      id: "ws-2",
      instance: createWorkspaceInstance(),
      name: "two",
      cwd: "/repo",
      worktreeBaseDir: "/wt",
      panes: [{ id: "pane-9", agentType: "claude", team: { teamId: "team-9", role: "lead" } }],
      teams: [
        {
          id: "team-9",
          name: "nine",
          location: {
            kind: "provisioning",
            intent: { repo: "/repo", path: "/wt/two-1", index: 1 },
          },
        },
      ],
    });
  });
  return "ws-2";
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
    preview.mockClear();
    errors.length = 0;
    backgroundCarriers.mockReset();
    backgroundCarriers.mockResolvedValue(["none"]);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("closing an agent with company names exactly that pane, by workspace ref", async () => {
    const wsId = seed();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.canCloseAgentOnly).toBe(false);
    expect(flow.worktreeCount).toBe(0);
    act(() => flow.confirmClose());
    expect(requested()).toEqual({
      kind: "agent",
      workspace: ref(),
      paneId: "pane-1",
      consent: NOTHING,
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

  describe("the last member of a team", () => {
    it("is offered its team's worktree, and confirming DISBANDS the team", async () => {
      const wsId = seed();
      await act(async () => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));
      expect(flow.canCloseAgentOnly).toBe(true);
      expect(preview).toHaveBeenCalledWith({ kind: "closeAgent", workspace: "ws-1", pane: "pane-2", consent: NOTHING });
      expect(lastOffer()).toEqual({
        teamId: "team-2",
        name: "wt",
        folders: [{ repo: "/repo", path: "/wt/2", branch: "kd/ws/2" }],
        tickets: [],
      });
      expect(flow.worktreeCount).toBe(1);
      expect(flow.closeMessage).toContain("It is the last agent on “wt”");

      act(() => flow.setDeleteWorktree(true));
      act(() => flow.confirmClose());
      // The offer the dialog showed IS the consent.
      expect(requested()).toEqual({
        kind: "team",
        workspace: ref(),
        teamId: "team-2",
        consent: { folders: [{ repo: "/repo", path: "/wt/2", branch: "kd/ws/2" }], tickets: [] },
      });
    });

    it("can close the agent alone — the team and its directory stay, whatever the box says", async () => {
      const wsId = seed();
      await act(async () => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));
      // A ticked box belongs to the disband; this is not one.
      act(() => flow.setDeleteWorktree(true));
      act(() => flow.closeAgentOnly());
      expect(requested()).toEqual({
        kind: "agent",
        workspace: ref(),
        paneId: "pane-2",
        consent: NOTHING,
      });
      expect(flow.closing).toBeNull();
    });

    it("on the workspace root has no worktree to offer, and still speaks both verbs", async () => {
      const wsId = seed();
      act(() => deck.closeAgent(wsId, "pane-0"));
      await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
      expect(flow.canCloseAgentOnly).toBe(true);
      expect(lastOffer().folders).toEqual([]);
      expect(flow.worktreeCount).toBe(0);
      act(() => flow.confirmClose());
      expect(requested()).toMatchObject({ kind: "team", teamId: "team-1" });
    });

    it("a member with company speaks one verb, and is never asked about a directory", async () => {
      const wsId = seed();
      await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
      expect(flow.canCloseAgentOnly).toBe(false);
      expect(flow.worktreeCount).toBe(0);
      expect(flow.closeMessage).not.toContain("last agent");
      act(() => flow.closeAgentOnly());
      expect(closeAgents).not.toHaveBeenCalled();
    });
  });

  it("disbanding a team names the team, counts its members and offers its worktree", async () => {
    const wsId = seed();
    await act(async () => flow.requestDisbandTeam(wsId, "team-2"));
    expect(flow.closing).toMatchObject({
      kind: "team",
      teamId: "team-2",
      name: "wt",
      count: 1,
      folders: [{ repo: "/repo", path: "/wt/2", branch: "kd/ws/2" }],
    });
    expect(flow.closeMessage).toBe(
      "This ends 1 agent and its session. The team is removed.",
    );
    expect(flow.canSuspendInstead).toBe(false);
    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    expect(requested()).toEqual({
      kind: "team",
      workspace: ref(),
      teamId: "team-2",
      consent: { folders: [{ repo: "/repo", path: "/wt/2", branch: "kd/ws/2" }], tickets: [] },
    });
  });

  it("says the machine's refusal of a confirmed close", async () => {
    const leaving: IntentOutcome = { kind: "refused", refusal: { kind: "alreadyClosing" } };
    closeAgents.mockResolvedValueOnce(leaving);
    const wsId = seed();
    await act(async () => flow.requestDisbandTeam(wsId, "team-2"));
    await act(async () => flow.confirmClose());
    expect(errors).toEqual([intentOutcomeText(leaving)]);
  });

  it("opens no dialog for a close the machine would refuse now, and says why", async () => {
    preview.mockResolvedValueOnce({ refusal: { kind: "alreadyClosing" }, stops: [], folders: [], creations: [], lastOf: null });
    const wsId = seed();
    await act(async () => flow.requestDisbandTeam(wsId, "team-2"));
    expect(flow.closing).toBeNull();
    expect(errors).toEqual([refusalText({ kind: "alreadyClosing" })]);
  });

  it("offers exactly the machine's offer — the hook adds no folder of its own", async () => {
    // The machine knows a folder this deck still draws is gone, or held by
    // another close: its offer leaves it out, and so does the dialog.
    preview.mockResolvedValueOnce({ refusal: null, stops: ["pane-2"], folders: [], creations: [], lastOf: null });
    const wsId = seed();
    await act(async () => flow.requestDisbandTeam(wsId, "team-2"));
    expect(flow.worktreeCount).toBe(0);
    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    expect(requested()).toMatchObject({ consent: NOTHING });
  });

  it("offers to delete a worktree that is still being created", async () => {
    // A team mid-create has no folder to name yet, but the create lands a
    // directory and branch that no surface would ever name again: the
    // machine offers its ticket.
    const wsId = creating();
    await act(async () => flow.requestCloseAgent(wsId, "pane-9", "Agent 1"));

    expect(lastOffer().folders).toEqual([]);
    expect(lastOffer().tickets).toEqual([100]);
    expect(flow.worktreeCount).toBe(1);

    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    expect(requested()).toMatchObject({ kind: "team", teamId: "team-9", consent: { folders: [], tickets: [100] } });
  });

  it("does not ask to delete an in-flight create the user left unticked", async () => {
    const wsId = creating();
    await act(async () => flow.requestCloseAgent(wsId, "pane-9", "Agent 1"));
    act(() => flow.confirmClose());

    expect(requested()).toMatchObject({ kind: "team", consent: NOTHING });
  });

  it("a create that already FAILED is not counted as a worktree to delete", async () => {
    const wsId = creating();
    act(() => deck.setTeamProvisioningError(wsId, "team-9", "boom"));
    await act(async () => flow.requestCloseAgent(wsId, "pane-9", "Agent 1"));
    expect(flow.worktreeCount).toBe(0);
  });

  it("closing a workspace names the workspace, not its panes", async () => {
    // Which panes a workspace holds is a fact about the deck at the moment
    // the close runs — reading it here would be a second answer to it.
    const wsId = seed();
    // The dialog opens only after the machine's preview answers.
    await act(async () => flow.requestCloseWorkspace(wsId));
    act(() => flow.confirmClose());
    expect(requested()).toEqual({
      kind: "workspace",
      workspace: ref(),
      consent: NOTHING,
    });
  });

  it("a workspace with NO carried pane keeps its sentence to the character", async () => {
    // The warning's area, workspace half: an all-ordinary workspace must
    // say exactly what it always said — one extra word would be noise on
    // every close, and a missing word is the harm itself.
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseWorkspace(wsId));
    // Three panes hold sessions by seed + binding here; the exact old text.
    expect(flow.closeMessage).toBe(
      "This ends 3 agents and their sessions.",
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
    expect(flow.closeMessage).toContain("This ends 3 agents");
  });

  it("a workspace where any ask failed warns too — the asymmetry holds per pane", async () => {
    backgroundCarriers.mockResolvedValueOnce(["none", "unknown"]);
    const wsId = seed();
    bindSession();
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toContain("may still be carried");
  });

  it("a workspace close offers every team's worktree the machine names, and hands back all of it", async () => {
    const wsId = seed([{ id: "pane-3", cwd: "/wt/3", branch: "kd/ws/3" }]);
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.worktreeCount).toBe(2);
    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    expect(requested()).toMatchObject({
      consent: {
        folders: [
          { repo: "/repo", path: "/wt/2", branch: "kd/ws/2" },
          { repo: "/repo", path: "/wt/3", branch: "kd/ws/3" },
        ],
        tickets: [],
      },
    });
  });

  it("a newer close request wins over a slower preview", async () => {
    let answer!: (offer: Preview) => void;
    preview.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const wsId = seed();
    act(() => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closing).toMatchObject({ kind: "agent", paneId: "pane-1" });

    await act(async () => answer(machinePreview({ kind: "closeAgent", workspace: "ws-1", pane: "pane-2", consent: NOTHING })));
    expect(flow.closing).toMatchObject({ kind: "agent", paneId: "pane-1" });
  });

  it("cancel closes nothing", async () => {
    const wsId = seed();
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    act(() => flow.cancelClose());
    expect(closeAgents).not.toHaveBeenCalled();
    expect(deck.workspaces[0].panes).toHaveLength(3);
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
      expect(deck.workspaces[0].panes).toHaveLength(3);
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
      // Awaited: the workspace's worktree team makes this dialog probe first.
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
              location: { kind: "remote", endpoint: "ws://vps:4500" },
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
    suspendAgent.mockClear().mockResolvedValue({ kind: "suspending" });
    preview.mockClear();
    errors.length = 0;
    refusals.length = 0;
    blockedPanes = {};
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("reports it as stopped, and offers no suspend", async () => {
    const wsId = seed();
    act(() =>
      deck.suspendPanes(wsId, ["pane-1"]),
    );
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));

    expect(agentSnapshot().stopped).toBe(true);
    expect(flow.canSuspendInstead).toBe(false);
  });

  it("does NOT call a rising pane stopped — it is about to run", async () => {
    // The dialog would otherwise say "it is stopped" about a pane that is
    // seconds from a live terminal, which is every pane just after launch.
    const wsId = seed();
    act(() => deck.suspendPanes(wsId, ["pane-1"]));
    act(() => deck.requestPanesWake(wsId, ["pane-1"]));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));

    expect(agentSnapshot().stopped).toBe(false);
  });

  it("surfaces a refused suspend instead of swallowing it", async () => {
    // The dialog is already dismissed by then, so a silent refusal leaves the
    // user with a pane that neither closed nor stopped and no explanation.
    const wsId = seed();
    suspendAgent.mockResolvedValueOnce({ kind: "blocked", why: "remote" });
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
    act(() => deck.suspendPanes(wsId, ["pane-1"]));
    act(() => deck.requestPanesWake(wsId, ["pane-1"]));
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
    suspendAgent.mockClear().mockResolvedValue({ kind: "suspending" });
    preview.mockClear();
    errors.length = 0;
    refusals.length = 0;
    blockedPanes = {};
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
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
    act(() => deck.suspendPanes(wsId, ["pane-2"]));
    await act(async () => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));

    expect(lastOffer().folders).toHaveLength(1); // its team does own one
    expect(flow.closeMessage).not.toContain("worktree");

    act(() => flow.confirmClose());
    await act(async () => {});
    expect(requested()).toMatchObject({ kind: "team", consent: NOTHING });
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
        location: { kind: "remote", endpoint: "ws://vps:4500" },
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
    act(() => deck.suspendPanes(wsId, ["pane-1"]));
    act(() => deck.requestPanesWake(wsId, ["pane-1"]));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.canSuspendInstead).toBe(true);

    // The sweep reports the folder gone while the dialog is up.
    blockedPanes = { "pane-1": "/gone/worktree" };
    act(() => root.render(createElement(Probe)));

    expect(flow.canSuspendInstead).toBe(true);
    // And taking it is still safe: the suspend flow re-checks and refuses,
    // where the refusal has somewhere to be said.
    suspendAgent.mockResolvedValueOnce({ kind: "blocked", why: "stopped" });
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
    act(() => deck.suspendPanes(wsId, ["pane-1"]));
    act(() => deck.requestPanesWake(wsId, ["pane-1"]));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    const opened = flow.closeMessage;
    expect(opened).toContain("It is starting up; closing removes the pane.");

    // The sweep's plan build fails and puts the pane back down.
    act(() => deck.failPaneWake(wsId, "pane-1"));
    expect(flow.closeMessage).toBe(opened);
    expect(flow.canSuspendInstead).toBe(true); // the row does not reshuffle
  });

  it("snapshots at OPEN, not at request — the preview runs in between", async () => {
    // `park` defers the dialog until the machine's preview answers, so facts
    // read before that call describe a pane the user never saw a dialog for.
    const wsId = seed();
    let release!: () => void;
    preview.mockImplementationOnce(
      (intent) => new Promise((resolve) => (release = () => resolve(machinePreview(intent)))),
    );
    act(() => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));
    expect(flow.closing).toBeNull(); // still previewing

    // The pane stops while the preview is out.
    act(() => deck.suspendPanes(wsId, ["pane-2"]));
    await act(async () => release());

    expect(flow.closing).not.toBeNull();
    expect(flow.closeMessage).toContain("It is stopped; closing removes the pane.");
    expect(flow.canSuspendInstead).toBe(false);
  });

  it("does not count an agent that has not started yet", async () => {
    // The ordinary shape of a just-launched deck: panes come back `waking`
    // and the revive sweep has not reached them. They have no session, so a
    // close ends none — the same distinction the agent branch draws with "It
    // is starting up", missing from the branch that counts.
    const wsId = seed();
    for (const paneId of ["pane-1", "pane-0", "pane-2"]) {
      act(() => deck.suspendPanes(wsId, [paneId]));
      act(() => deck.requestPanesWake(wsId, [paneId]));
    }

    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toBe("This ends no sessions; closing removes 3 agents.");
  });

  it("counts the agents a workspace close ends", async () => {
    const wsId = seed();
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toBe("This ends 3 agents and their sessions.");
  });

  it("does not count a stopped agent's session among the ones it ends", async () => {
    // The same lie `closingIsStopped` removed from the agent branch, still
    // being told one branch over: a suspended agent has no session left to
    // end, and a workspace of them ends none at all.
    const wsId = seed();
    act(() => deck.suspendPanes(wsId, ["pane-1"]));
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toBe("This ends 2 agents and their sessions.");

    act(() => deck.suspendPanes(wsId, ["pane-0"]));
    act(() => deck.suspendPanes(wsId, ["pane-2"]));
    await act(async () => flow.requestCloseWorkspace(wsId));
    expect(flow.closeMessage).toBe("This ends no sessions; closing removes 3 agents.");
  });

  it("counts only a team's own members for a disband", async () => {
    const wsId = seed();
    act(() => deck.suspendPanes(wsId, ["pane-0"]));
    await act(async () => flow.requestDisbandTeam(wsId, "team-1"));
    expect(flow.closeMessage).toBe(
      "This ends 1 agent and its session. The team is removed.",
    );
  });

  it("does not promise to end a session a pane never had", async () => {
    // A pane still creating its worktree has never run, and one on its way up
    // has not started yet. Neither has a terminal session to end, and the
    // second was being offered "keep its session" in the same breath.
    const creatingWs = creating();
    await act(async () => flow.requestCloseAgent(creatingWs, "pane-9", "Agent 1"));
    expect(flow.closeMessage).toContain("Its worktree is still being created.");
    expect(flow.closeMessage).not.toContain("will be ended");

    const wsId = seed();
    act(() => deck.suspendPanes(wsId, ["pane-1"]));
    act(() => deck.requestPanesWake(wsId, ["pane-1"]));
    await act(async () => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closeMessage).toContain("It is starting up");
    expect(flow.closeMessage).not.toContain("will be ended");
  });
});
