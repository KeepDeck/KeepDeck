import { useRef, useState } from "react";
import {
  findPane,
  findTeam,
  findWorkspace,
  membersOf,
  paneAgentType,
  paneHasProcess,
  teamOfPane,
  teamsOf,
  type GitPosition,
  type Pane,
  type WorktreeTarget,
  type Workspace,
} from "../domain/deck";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import { probeWorktree } from "../ipc/worktree";
import { closeMessageFor } from "./closing/closeMessage";
// The model and the copy moved to modules of their own; they are still part
// of what this flow IS, so its consumers keep taking them from here.
export { closeMessageFor } from "./closing/closeMessage";
export type {
  CarrierNote,
  ClosingPaneFacts,
  ClosingTarget,
  TeamTeardownOffer,
} from "./closing/closingTarget";
import {
  paneFactsOf,
  pendingCreates,
  type CarrierNote,
  type ClosingTarget,
  type TeamTeardownOffer,
} from "./closing/closingTarget";
import { deletableWorktrees, existingTargets } from "./closing/teardownTargets";
import { suspendRefusalText, type SuspendOutcome } from "./suspendOutcome";
import type { BackgroundCarrier } from "./liveSessions";
import type { CloseRequest } from "./agentOrchestrator";
import type { Deck } from "./useDeck";

/** The late-painted carrier line: set only when the registry's answer
 * WARNS ("background" proven, or the ask failed = "unknown"). A "none"
 * answer never sets it — the ordinary close's text stays untouched to the
 * character and the dialog does not even re-render. */
export function useCloseFlow(
  deck: Deck,
  /** The hook's collaborators, named rather than positional: the list grew to
   * four and its tail was two optionals nobody omitted, where forgetting one
   * silently dropped a feature instead of failing to compile. */
  deps: {
    onError(message: string): void;
    /** A suspend the dialog offered and the flow then refused. Separate from
     * `onError`, which reports worktree trouble: the two reach the user as
     * headed alerts, and one heading cannot honestly cover both. */
    onSuspendRefused(message: string): void;
    /** Live git HEADs, for naming the branches a close would delete. */
    gitPositions: ReadonlyMap<string, GitPosition>;
    /** paneId → the missing directory, from the revive sweep. A pane stuck on
     * a gone folder has no process; without this the dialog would promise to
     * end a session that isn't there and offer to suspend a dead pane. */
    blockedPanes: Record<string, string>;
    /** Suspend an agent instead of closing it — the dialog's third action.
     * Injected rather than imported so this hook keeps owning only the close
     * decision. */
    suspendAgent(wsId: string, paneId: string): Promise<SuspendOutcome>;
    /** Carry out a close the user has confirmed, resolving to the worktrees
     * it could not delete. Injected for the same reason: what this hook owns
     * is the CONFIRMATION — which panes, which directories, and whether the
     * user meant it — not the teardown that follows. */
    closeAgents(request: CloseRequest): Promise<string[]>;
    /** Ask the agent's live registry whether panes' conversations are
     * carried by a background process — the fact the close sentence must
     * say before the pane is gone. Batched: ONE registry query per
     * distinct agent, answers aligned to the entries. Injected like
     * everything else: the registry is the plugins' world, and this hook
     * owns the close. */
    backgroundCarriers(entries: {
      agentType: string;
      sessionId: string;
    }[]): Promise<BackgroundCarrier[]>;
  },
) {
  const {
    onError,
    onSuspendRefused,
    gitPositions,
    blockedPanes,
    suspendAgent,
    closeAgents,
    backgroundCarriers,
  } = deps;
  const [closing, setClosing] = useState<ClosingTarget | null>(null);
  // The late-painted carrier line (see `CarrierNote`). Set ONLY by the ask
  // of the dialog that is still current; cleared whenever a dialog opens,
  // is confirmed, or is cancelled.
  const [carrier, setCarrier] = useState<CarrierNote | null>(null);
  // Opt-in: also delete the closing target's worktree(s) + branch(es). Reset
  // each time the dialog opens so the destructive choice is never sticky.
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  // Dialog generation: bumped by every open, confirm and cancel. The open
  // flow keys its probe on it, and an in-flight registry ask keys its
  // LATE PAINT on it — an answer arriving after the dialog is gone (or
  // after a newer one opened) drops instead of writing into a dialog it
  // was never asked for.
  const requestSeq = useRef(0);
  // The dialog's facts are read when it OPENS, which is after the probe —
  // a render later than the click, so the render-time values are stale by
  // then. These carry the live ones across.
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const blockedRef = useRef(blockedPanes);
  blockedRef.current = blockedPanes;

  /** Fire the registry ask for the dialog of `seq`, painting the carrier
   * line when — and only when — the answer warns. A "none" answer paints
   * nothing: the ordinary close neither re-renders nor changes a
   * character. */
  const askCarriers = (
    seq: number,
    entries: { agentType: string; sessionId: string }[],
  ) => {
    if (entries.length === 0) return;
    void backgroundCarriers(entries)
      .then((answers) => {
        if (seq !== requestSeq.current) return; // dialog gone or replaced
        const kind = answers.includes("background")
          ? "background"
          : answers.includes("unknown")
            ? "unknown"
            : null;
        if (kind) setCarrier({ kind });
      })
      .catch(() => {
        if (seq === requestSeq.current) setCarrier({ kind: "unknown" });
      });
  };

  /** Open the confirm dialog once the candidate worktrees are probed. A
   * close with no candidates skips the probe and opens synchronously. The
   * REGISTRY ask is deliberately not part of this wait — the dialog opens
   * on the base facts alone and the carrier line paints when the answer
   * lands. */
  const park = (
    candidates: WorktreeTarget[],
    make: (targets: WorktreeTarget[]) => ClosingTarget,
    ask: (seq: number) => void,
  ) => {
    const seq = ++requestSeq.current;
    setCarrier(null);
    ask(seq);
    const open = (targets: WorktreeTarget[]) => {
      setDeleteWorktree(false);
      setClosing(make(targets));
    };
    if (candidates.length === 0) {
      open([]);
      return;
    }
    void existingTargets(candidates, probeWorktree).then((targets) => {
      if (seq === requestSeq.current) open(targets);
    });
  };

  /** One carrier ask per BOUND pane among `panes` (a stopped pane's
   * conversation can be carried too), folded by `askCarriers` per the
   * asymmetry rule: any "background" wins, then any "unknown", else nothing
   * at all. */
  const carrierEntries = (panes: readonly Pane[]) =>
    panes
      .filter((pane) => pane.session?.id)
      .map((pane) => ({
        agentType: paneAgentType(pane),
        sessionId: pane.session!.id,
      }));

  /** What this close would delete, as the dialog must say it — the same
   * decision the teardown runs, asked here for the sentence. */
  const offerFor = (ws: Workspace, ending: readonly string[]): WorktreeTarget[] =>
    deletableWorktrees({
      workspaces: deck.workspaces,
      workspace: ws,
      root: ws.cwd,
      ending,
      gitPositions,
    });

  const refOf = (ws: Workspace): WorkspaceRef => ({ id: ws.id, instance: ws.instance });

  const requestCloseAgent = (wsId: string, paneId: string, label: string) => {
    const ws = findWorkspace(deck.workspaces, wsId);
    const pane = ws?.panes.find((candidate) => candidate.id === paneId);
    if (!ws || !pane) return;
    const workspace = refOf(ws);
    // The last member of its team: the dialog offers the team's worktree,
    // because the primary verb there is disbanding.
    const team = teamOfPane(ws, pane);
    const last = team && membersOf(ws, team.id).length === 1 ? team : null;
    // The registry ask fires in flight and its answer PAINTS the carrier
    // line when it lands; the dialog does not wait for it (the standing
    // rule: opens stay instant). A pane with no session binding has
    // nothing to ask about.
    park(
      last ? offerFor(ws, [last.id]) : [],
      (targets) => ({
        kind: "agent",
        workspace,
        paneId,
        label,
        pane: paneFactsOf(
          findWorkspace(deckRef.current.workspaces, wsId),
          findPane(deckRef.current.workspaces, wsId, paneId),
          paneId in blockedRef.current,
        ),
        last: last
          ? { teamId: last.id, name: last.name, targets, pending: pendingCreates([last]) }
          : null,
      }),
      (seq) => askCarriers(seq, carrierEntries([pane])),
    );
  };

  const requestDisbandTeam = (wsId: string, teamId: string) => {
    const ws = findWorkspace(deck.workspaces, wsId);
    const team = ws ? findTeam(ws, teamId) : undefined;
    if (!ws || !team) return;
    const members = membersOf(ws, team.id);
    park(
      offerFor(ws, [team.id]),
      (targets) => ({
        kind: "team",
        workspace: refOf(ws),
        teamId: team.id,
        name: team.name,
        count: members.length,
        targets,
        pending: pendingCreates([team]),
      }),
      (seq) => askCarriers(seq, carrierEntries(members)),
    );
  };

  const requestCloseWorkspace = (id: string) => {
    const ws = findWorkspace(deck.workspaces, id);
    if (!ws) return;
    park(
      offerFor(ws, teamsOf(ws).map((team) => team.id)),
      (targets) => ({
        kind: "workspace",
        workspace: refOf(ws),
        name: ws.name,
        count: ws.panes.length,
        targets,
        pending: pendingCreates(teamsOf(ws)),
      }),
      (seq) => askCarriers(seq, carrierEntries(ws.panes)),
    );
  };

  /** The dialog is gone: retire its generation so a straggling registry
   * answer cannot paint into whatever opens next, and hand the close off. */
  const dismissWith = (request: CloseRequest) => {
    requestSeq.current++;
    setCarrier(null);
    setClosing(null);
    setDeleteWorktree(false);
    void closeAgents(request).then((failures) => {
      if (failures.length > 0)
        onError(
          `Failed to delete worktree${failures.length === 1 ? "" : "s"}:\n${failures.join("\n")}`,
        );
    });
  };

  const confirmClose = () => {
    if (!closing) return;
    // The destructive choice is settled here and nowhere later: what the
    // dialog offered, against the box the user actually ticked.
    // The DECISION travels separately from the list. This list was frozen when
    // the dialog opened and cannot be complete — a create landing while the
    // user reads it owns a worktree nothing here has ever seen — so the close
    // finishes it against the live deck. What this list still contributes is
    // the observed branch per team, which a bare team read cannot give.
    const teardown = (offer: TeamTeardownOffer) => ({
      deleteWorktrees: deleteWorktree,
      worktrees: deleteWorktree ? offer.targets : [],
    });
    switch (closing.kind) {
      case "agent":
        // The last member's primary verb is disbanding: the pane goes, the
        // team with it, and the box decides the directory.
        dismissWith(
          closing.last
            ? {
                kind: "team",
                workspace: closing.workspace,
                teamId: closing.last.teamId,
                ...teardown(closing.last),
              }
            : { kind: "agent", workspace: closing.workspace, paneId: closing.paneId },
        );
        return;
      case "team":
        dismissWith({
          kind: "team",
          workspace: closing.workspace,
          teamId: closing.teamId,
          ...teardown(closing),
        });
        return;
      case "workspace":
        dismissWith({
          kind: "workspace",
          workspace: closing.workspace,
          ...teardown(closing),
        });
        return;
    }
  };

  /** The last member's second verb: end the agent alone. The team and its
   * directory stay, whatever the box says — a ticked box belongs to the
   * disband, and this is not one. */
  const closeAgentOnly = () => {
    if (closing?.kind !== "agent" || !closing.last) return;
    dismissWith({ kind: "agent", workspace: closing.workspace, paneId: closing.paneId });
  };

  const cancelClose = () => {
    if (!closing) return;
    // Same retirement as confirming: the dialog is gone, its in-flight
    // ask must not paint anywhere.
    requestSeq.current++;
    setCarrier(null);
    setClosing(null);
  };

  /** Whether the dialog offers suspending instead of closing at all — from
   * the snapshot it opened with, so the button row cannot reshuffle
   * mid-gesture (see `ClosingTarget.pane`). A team or workspace close is
   * deliberately never offered it: "suspend" there would mean "don't close,
   * park all N agents" — a different verb on a different object, which a
   * button sitting inside "Disband team?" cannot honestly say. */
  const canSuspendInstead = closing?.kind === "agent" && closing.pane.canSuspend;

  /** Whether the dialog speaks the last member's two verbs. */
  const canCloseAgentOnly = closing?.kind === "agent" && closing.last !== null;

  /** How many of a closing team's or workspace's agents still hold a
   * session. Live: such a close names no pane, so there is nothing to have
   * frozen, and the count only ever shrinks toward the truth. */
  const runningAgentsOf = (target: ClosingTarget | null): number => {
    if (!target || target.kind === "agent") return 0;
    const ws = findWorkspace(deck.workspaces, target.workspace.id);
    if (!ws) return 0;
    const panes = target.kind === "team" ? membersOf(ws, target.teamId) : ws.panes;
    // A session exists only behind a live process. `idle` of ANY reason means
    // there is none — including `waking`, which is a pane whose session is
    // still ahead of it — and a pane mid-create has never had one. Asking
    // "does it read as stopped" instead counted every rising pane as holding
    // a session it has not opened yet, which is what a just-launched
    // workspace is entirely made of.
    return panes.filter((pane) => paneHasProcess(ws, pane)).length;
  };

  const closeMessage = closeMessageFor(
    closing,
    runningAgentsOf(closing),
    carrier,
  );

  /** How many worktrees the delete offer covers — the ones that exist plus the
   * creates still out. The dialog gates its checkbox on this rather than on
   * `targets`, which cannot see a team mid-create. Zero for a member with
   * company: its close is never asked about a directory. */
  const offer: TeamTeardownOffer | null =
    closing === null ? null : closing.kind === "agent" ? closing.last : closing;
  const worktreeCount = offer ? offer.targets.length + offer.pending : 0;

  /**
   * Take the alternative: dismiss the dialog and park the agent.
   *
   * Refused while the worktree-delete checkbox is ticked, and the button is
   * disabled to match. The two are contradictory — a suspended pane keeps
   * pointing at that worktree and expects to come back to it — and of the two
   * ways to resolve the contradiction, silently ignoring a box the user
   * ticked is the worse one.
   */
  const suspendInstead = () => {
    if (!canSuspendInstead || closing?.kind !== "agent" || deleteWorktree) return;
    const { workspace, paneId } = closing;
    setClosing(null);
    setDeleteWorktree(false);
    // The dialog is already gone by the time this settles, so a refusal has
    // nowhere to appear unless it is surfaced here — this was the one caller
    // that dropped the outcome the other two turn into a sentence.
    const label = closing.label;
    void Promise.resolve(suspendAgent(workspace.id, paneId)).then((outcome) => {
      if (outcome !== "suspended")
        onSuspendRefused(suspendRefusalText(outcome, label));
    });
  };

  return {
    closing,
    closeMessage,
    worktreeCount,
    deleteWorktree,
    setDeleteWorktree,
    requestCloseAgent,
    requestDisbandTeam,
    requestCloseWorkspace,
    confirmClose,
    closeAgentOnly,
    canCloseAgentOnly,
    cancelClose,
    canSuspendInstead,
    suspendInstead,
  };
}
