import { useRef, useState } from "react";
import {
  findPane,
  findTeam,
  findWorkspace,
  membersOf,
  paneHasProcess,
  type Pane,
  type Workspace,
} from "../domain/deck";
import type { Consent, IntentOutcome, SuspendResult } from "../domain/lifecycle";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import type { Intent } from "../ipc/generated/lifecycle/Intent";
import type { Preview } from "../ipc/generated/lifecycle/Preview";
import { closeMessageFor, type CarrierNote } from "../presentation/closeWords";
import { intentOutcomeText, refusalText } from "../presentation/lifecycleWords";
import { suspendResultText } from "../presentation/suspendWords";
import { offerSize, paneFactsOf, type ClosingTarget, type TeamTeardownOffer } from "./closing/closingTarget";
import type { BackgroundCarrier } from "./liveSessions";
import type { CloseRequest } from "./agentOrchestrator";
import type { Deck } from "./useDeck";

/** A close that deletes nothing: an agent's alone, or one whose box was
 * left unticked. */
const NOTHING: Consent = { folders: [], tickets: [] };

/**
 * Owns the confirmed-close flow: all three close paths ([U6]) park a
 * ClosingTarget for the confirm dialog — once the lifecycle machine has
 * said what the close would end and may delete (`lifecycle_preview`), so
 * the dialog offers exactly the machine's offer, and a confirm hands that
 * offer back as the consent, unchanged. What the delete rule is — which
 * folders, which branches — is the machine's alone; this hook shows it and
 * freezes it.
 *
 * A directory is a TEAM's: closing one agent is never asked about one, and
 * only a disband (or a workspace close, which disbands every team) carries
 * the offer. The last member of a team is the one pane whose close dialog
 * speaks both verbs.
 */
export function useCloseFlow(
  deck: Deck,
  /** The hook's collaborators, named rather than positional. */
  deps: {
    /** A close the machine would not take, or refused at the confirm. */
    onError(message: string): void;
    /** A suspend the dialog offered and the flow then refused. Separate from
     * `onError`: the two reach the user as headed alerts, and one heading
     * cannot honestly cover both. */
    onSuspendRefused(message: string): void;
    /** paneId → the missing directory, from the revive sweep. A pane stuck on
     * a gone folder has no process; without this the dialog would promise to
     * end a session that isn't there and offer to suspend a dead pane. */
    blockedPanes: Record<string, string>;
    /** What the machine would do with a close: what it ends, what it may
     * delete, or why it would refuse it now. */
    preview(intent: Intent): Promise<Preview>;
    /** Suspend an agent instead of closing it — the dialog's third action. */
    suspendAgent(wsId: string, paneId: string): Promise<SuspendResult>;
    /** Carry out a close the user has confirmed, with exactly the consent
     * its dialog showed. */
    closeAgents(request: CloseRequest): Promise<IntentOutcome>;
    /** Ask the agent's live registry whether panes' conversations are
     * carried by a background process — the fact the close sentence must
     * say before the pane is gone. Batched: ONE registry query per
     * distinct agent, answers aligned to the entries. */
    backgroundCarriers(entries: {
      agentType: string;
      sessionId: string;
    }[]): Promise<BackgroundCarrier[]>;
  },
) {
  const { onError, onSuspendRefused, blockedPanes, preview, suspendAgent, closeAgents, backgroundCarriers } = deps;
  const [closing, setClosing] = useState<ClosingTarget | null>(null);
  // The late-painted carrier line (see `CarrierNote`). Set ONLY by the ask
  // of the dialog that is still current; cleared whenever a dialog opens,
  // is confirmed, or is cancelled.
  const [carrier, setCarrier] = useState<CarrierNote | null>(null);
  // Opt-in: also delete the closing target's worktree(s) + branch(es). Reset
  // each time the dialog opens so the destructive choice is never sticky.
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  // Dialog generation: bumped by every open, confirm and cancel. The open
  // flow keys its preview on it, and an in-flight registry ask keys its
  // LATE PAINT on it — an answer arriving after the dialog is gone (or
  // after a newer one opened) drops instead of writing into a dialog it
  // was never asked for.
  const requestSeq = useRef(0);
  // The dialog's facts are read when it OPENS, which is after the preview —
  // a render later than the click, so the render-time values are stale by
  // then. These carry the live ones across.
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const blockedRef = useRef(blockedPanes);
  blockedRef.current = blockedPanes;

  /** Fire the registry ask for the dialog of `seq`, painting the carrier
   * line when — and only when — the answer warns. */
  const askCarriers = (seq: number, entries: { agentType: string; sessionId: string }[]) => {
    if (entries.length === 0) return;
    void backgroundCarriers(entries)
      .then((answers) => {
        if (seq !== requestSeq.current) return; // dialog gone or replaced
        const kind = answers.includes("background") ? "background" : answers.includes("unknown") ? "unknown" : null;
        if (kind) setCarrier({ kind });
      })
      .catch(() => {
        if (seq === requestSeq.current) setCarrier({ kind: "unknown" });
      });
  };

  /** Open the confirm dialog once the machine has previewed the close. A
   * close it would refuse now opens nothing and says why. The REGISTRY ask
   * is deliberately not part of this wait — the carrier line paints when
   * its answer lands. */
  const park = (intent: Intent, make: (offer: Preview) => ClosingTarget, carriers: readonly Pane[]) => {
    const seq = ++requestSeq.current;
    setCarrier(null);
    askCarriers(seq, carrierEntries(carriers));
    void preview(intent).then(
      (offer) => {
        if (seq !== requestSeq.current) return;
        if (offer.refusal !== null) {
          onError(refusalText(offer.refusal));
          return;
        }
        setDeleteWorktree(false);
        setClosing(make(offer));
      },
      () => {
        if (seq === requestSeq.current) onError(refusalText({ kind: "barrierUp" }));
      },
    );
  };

  /** One carrier ask per BOUND pane among `panes` (a stopped pane's
   * conversation can be carried too). */
  const carrierEntries = (panes: readonly Pane[]) =>
    panes.flatMap((pane) => (pane.session?.id ? [{ agentType: pane.agentType, sessionId: pane.session.id }] : []));

  /** The machine's offer, as the consent a ticked box would give. */
  const offerOf = (offer: Preview): TeamTeardownOffer => ({ folders: offer.folders, tickets: offer.creations });

  const refOf = (ws: Workspace): WorkspaceRef => ({ id: ws.id, instance: ws.instance });

  const requestCloseAgent = (wsId: string, paneId: string, label: string) => {
    const ws = findWorkspace(deck.workspaces, wsId);
    const pane = ws?.panes.find((candidate) => candidate.id === paneId);
    if (!ws || !pane) return;
    const workspace = refOf(ws);
    park(
      { kind: "closeAgent", workspace: ws.id, pane: paneId, consent: NOTHING },
      (offer) => {
        // The last member of its team: the machine offers the team's
        // disband beside it, worktree and all — the primary verb there.
        const lastOf = offer.lastOf;
        const team = lastOf ? findTeam(ws, lastOf[0]) : undefined;
        return {
          kind: "agent",
          workspace,
          paneId,
          label,
          pane: paneFactsOf(
            findWorkspace(deckRef.current.workspaces, wsId),
            findPane(deckRef.current.workspaces, wsId, paneId),
            paneId in blockedRef.current,
          ),
          last: lastOf && team ? { teamId: team.id, name: team.name, ...offerOf(lastOf[1]) } : null,
        };
      },
      [pane],
    );
  };

  const requestDisbandTeam = (wsId: string, teamId: string) => {
    const ws = findWorkspace(deck.workspaces, wsId);
    const team = ws ? findTeam(ws, teamId) : undefined;
    if (!ws || !team) return;
    const members = membersOf(ws, team.id);
    park(
      { kind: "disband", workspace: ws.id, team: team.id, consent: NOTHING },
      (offer) => ({ kind: "team", workspace: refOf(ws), teamId: team.id, name: team.name, count: members.length, ...offerOf(offer) }),
      members,
    );
  };

  const requestCloseWorkspace = (id: string) => {
    const ws = findWorkspace(deck.workspaces, id);
    if (!ws) return;
    park(
      { kind: "closeWorkspace", workspace: ws.id, consent: NOTHING },
      (offer) => ({ kind: "workspace", workspace: refOf(ws), name: ws.name, count: ws.panes.length, ...offerOf(offer) }),
      ws.panes,
    );
  };

  /** The dialog is gone: retire its generation so a straggling registry
   * answer cannot paint into whatever opens next, and hand the close off. */
  const dismissWith = (request: CloseRequest) => {
    requestSeq.current++;
    setCarrier(null);
    setClosing(null);
    setDeleteWorktree(false);
    void closeAgents(request).then((outcome) => {
      const why = intentOutcomeText(outcome);
      if (why !== null) onError(why);
    });
  };

  const confirmClose = () => {
    if (!closing) return;
    // The destructive choice is settled here and nowhere later: the offer
    // the dialog showed, frozen as the consent, against the box the user
    // actually ticked. The machine re-checks it at the confirm: what is gone
    // narrows it, and nothing it did not show is ever added.
    const consent = (offer: TeamTeardownOffer): Consent =>
      deleteWorktree ? { folders: offer.folders, tickets: offer.tickets } : NOTHING;
    switch (closing.kind) {
      case "agent":
        // The last member's primary verb is disbanding: the pane goes, the
        // team with it, and the box decides the directory.
        dismissWith(
          closing.last
            ? { kind: "team", workspace: closing.workspace, teamId: closing.last.teamId, consent: consent(closing.last) }
            : { kind: "agent", workspace: closing.workspace, paneId: closing.paneId, consent: NOTHING },
        );
        return;
      case "team":
        dismissWith({ kind: "team", workspace: closing.workspace, teamId: closing.teamId, consent: consent(closing) });
        return;
      case "workspace":
        dismissWith({ kind: "workspace", workspace: closing.workspace, consent: consent(closing) });
        return;
    }
  };

  /** The last member's second verb: end the agent alone. The team and its
   * directory stay, whatever the box says — a ticked box belongs to the
   * disband, and this is not one. */
  const closeAgentOnly = () => {
    if (closing?.kind !== "agent" || !closing.last) return;
    dismissWith({ kind: "agent", workspace: closing.workspace, paneId: closing.paneId, consent: NOTHING });
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
   * deliberately never offered it. */
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
    // A session exists only behind a live process: `idle` of ANY reason
    // means there is none, and a pane mid-create has never had one.
    return panes.filter((pane) => paneHasProcess(ws, pane)).length;
  };

  const closeMessage = closeMessageFor(closing, runningAgentsOf(closing), carrier);

  /** How many worktrees the delete offer covers — the folders it names plus
   * the creates still out. Zero for a member with company: its close is
   * never asked about a directory. */
  const offer: TeamTeardownOffer | null = closing === null ? null : closing.kind === "agent" ? closing.last : closing;
  const worktreeCount = offer ? offerSize(offer) : 0;

  /**
   * Take the alternative: dismiss the dialog and park the agent.
   *
   * Refused while the worktree-delete checkbox is ticked, and the button is
   * disabled to match: a suspended pane keeps pointing at that worktree and
   * expects to come back to it.
   */
  const suspendInstead = () => {
    if (!canSuspendInstead || closing?.kind !== "agent" || deleteWorktree) return;
    const { workspace, paneId, label } = closing;
    setClosing(null);
    setDeleteWorktree(false);
    // The dialog is already gone by the time this settles, so a refusal has
    // nowhere to appear unless it is surfaced here.
    void suspendAgent(workspace.id, paneId).then((result) => {
      const why = suspendResultText(result, label);
      if (why !== null) onSuspendRefused(why);
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
