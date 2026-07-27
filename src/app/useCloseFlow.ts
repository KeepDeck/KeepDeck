import { useRef, useState } from "react";
import {
  findPane,
  findWorkspace,
  idleReadsAsStopped,
  paneHasProcess,
  paneSuspendBlock,
  paneWakesAutomatically,
  worktreeTargets,
  type GitPosition,
  type Pane,
  type WorktreeTarget,
} from "../domain/deck";
import { probeWorktree } from "../ipc/worktree";
import { suspendRefusalText, type SuspendOutcome } from "./suspendOutcome";
import type { CloseRequest } from "./agentOrchestrator";
import type { Deck } from "./useDeck";

/** A pending close awaiting confirmation ([U6]) — an agent pane or a whole
 * workspace. Closing tears down live PTY session(s) immediately, so both are
 * confirmed before they run. `targets` is the worktrees the close could also
 * delete (empty in non-worktree mode), snapshotted — and probed for
 * existence — at open time; the modal blocks all mutation, so it can't go
 * stale. */
export type ClosingTarget = {
  targets: WorktreeTarget[];
  /** Closing panes whose worktree create is still in flight. They have no
   * `cwd` yet, so `worktreeTargets` cannot describe them and they are absent
   * from `targets` — but a create that lands after the close leaves a
   * directory and branch nothing will ever name again, so the offer has to
   * cover them. What each one actually made is only known once it settles. */
  pendingPanes: string[];
} & (
  | {
      kind: "agent";
      wsId: string;
      paneId: string;
      label: string;
      /** Everything the dialog says or offers about the pane, read at the
       * moment it opened — ALL of it, deliberately.
       *
       * Derived live, the offer vanished under the pointer: the revive sweep
       * reporting a gone folder mid-dialog removed the middle button and slid
       * the destructive Close into the slot the user was aiming at. Splitting
       * the facts was worse than either: with `stopped` frozen and `rising`
       * live, a pane that stopped while the dialog was up produced a sentence
       * neither rule would give — "Its terminal session will be ended" about
       * a pane with no process.
       *
       * So they travel together, and the actions re-check rather than the
       * text: the suspend refuses a stale offer at the click, and says so. */
      pane: ClosingPaneFacts;
    }
  | { kind: "workspace"; id: string; name: string; count: number }
);

/** Keep only targets whose directory is still there: offering to delete a
 * worktree that's already gone is noise, and taking the offer can only fail
 * (the "Folder is gone" tile, or a worktree removed under a live pane). Only
 * a positive "not there" drops a target — a probe that REJECTS (IPC trouble,
 * not a missing path) keeps it, degrading to the old always-offer behavior. */
async function liveTargets(
  candidates: WorktreeTarget[],
): Promise<WorktreeTarget[]> {
  const checked = await Promise.all(
    candidates.map((target) =>
      probeWorktree(target.path).then(
        (probe) => (probe.exists ? [target] : []),
        () => [target],
      ),
    ),
  );
  return checked.flat();
}

/** The pane as the dialog found it, frozen when the dialog opened. */
export interface ClosingPaneFacts {
  /** The pane's worktree create is still in flight — it has never run. */
  provisioning: boolean;
  /** On its way up: no session YET, as opposed to none any more. */
  rising: boolean;
  /** Reads as stopped to the user (see `idleReadsAsStopped`). */
  stopped: boolean;
  /** Suspend is on offer. */
  canSuspend: boolean;
}

/** Read the pane's facts as one set, so no caller can take half of them. */
function paneFactsOf(pane: Pane | undefined, blocked: boolean): ClosingPaneFacts {
  return {
    provisioning: !!pane?.provisioning,
    rising: !!pane && paneWakesAutomatically(pane),
    stopped: !!pane && idleReadsAsStopped(pane.idle, blocked),
    canSuspend: !!pane && paneSuspendBlock(pane, blocked) === null,
  };
}

/**
 * What closing will actually do, in the dialog's own words.
 *
 * A pure function rather than a hook-body expression: the sentence has been
 * wrong three times — it promised to delete a worktree the default path
 * keeps, to end sessions of agents that were already stopped, and to end one
 * a pane had never opened — and every correction was verified only by driving
 * the whole hook. Here the table is addressable on its own, so a case can be
 * pinned without a workspace, a probe and a render.
 */
export function closeMessageFor(
  closing: ClosingTarget | null,
  /** For a workspace close: how many of its agents still hold a session.
   * The only fact this cannot take from the snapshot, because a workspace
   * close is about panes it does not name individually. */
  runningAgents: number,
): string {
  if (!closing) return "";
  if (closing.kind === "workspace") {
    if (closing.count === 0) return "This workspace has no agents.";
    // Only the agents that actually HOLD a session are counted as losing one.
    // "Stopped" is not the word for all of them — a pane on its way up has no
    // session YET, and one mid-create has never had one — so the none-running
    // case says what is true of every way of having none, rather than
    // branching on a distinction this sentence does not need.
    if (runningAgents === 0) {
      return closing.count === 1
        ? "This ends no session; closing removes 1 agent."
        : `This ends no sessions; closing removes ${closing.count} agents.`;
    }
    return runningAgents === 1
      ? "This ends 1 agent and its session."
      : `This ends ${runningAgents} agents and their sessions.`;
  }
  const facts = closing.pane;
  // Never ran: no session to end, and nothing to suspend.
  if (facts.provisioning) return "Its worktree is still being created.";
  // A stopped pane has no session to end, and saying so would contradict the
  // card the user is looking at. Whether the worktree survives is the
  // checkbox's business, not this sentence's.
  if (facts.stopped) return "It is stopped; closing removes the pane.";
  // Mutually exclusive with the branch above by construction: a stopped pane
  // is exactly the one `paneSuspendBlock` refuses.
  const alternative = facts.canSuspend
    ? closing.targets.length > 0
      ? "\nSuspending stops the agent instead, keeping the pane, its worktree and its session."
      : "\nSuspending stops the agent instead, keeping the pane and its session."
    : "";
  // A pane on its way up has no session YET — promising to end one, while the
  // line below offers to keep "its session", described a pane that does not
  // exist in either direction.
  const opening = facts.rising
    ? "It is starting up; closing removes the pane."
    : "Its terminal session will be ended.";
  return opening + alternative;
}

/**
 * Owns the confirmed-close flow: both close paths ([U6]) park a ClosingTarget
 * for the confirm dialog — once its candidate worktrees are probed, so a
 * directory that's already gone is never offered for deletion; confirming
 * removes the pane(s) from the deck AND ends their PTY sessions through the
 * ptyManager (unmounting alone no longer kills a process), then optionally
 * tears the worktrees down per the delete checkbox — after the closes settle,
 * so no worktree dir is a live cwd.
 */
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
  },
) {
  const {
    onError,
    onSuspendRefused,
    gitPositions,
    blockedPanes,
    suspendAgent,
    closeAgents,
  } = deps;
  const [closing, setClosing] = useState<ClosingTarget | null>(null);
  // Opt-in: also delete the closing target's worktree(s) + branch(es). Reset
  // each time the dialog opens so the destructive choice is never sticky.
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  // Close requests are numbered: target probing is async, and a slower
  // earlier request must not open its dialog over a newer one's.
  const requestSeq = useRef(0);
  // The dialog's facts are read when it OPENS, which is after the probe —
  // a render later than the click, so the render-time values are stale by
  // then. These carry the live ones across.
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const blockedRef = useRef(blockedPanes);
  blockedRef.current = blockedPanes;

  /** Open the confirm dialog once the candidate worktrees are probed. A close
   * with no candidates skips the probe and opens synchronously, as before. */
  const park = (
    candidates: WorktreeTarget[],
    make: (targets: WorktreeTarget[]) => ClosingTarget,
  ) => {
    const seq = ++requestSeq.current;
    const open = (targets: WorktreeTarget[]) => {
      setDeleteWorktree(false);
      setClosing(make(targets));
    };
    if (candidates.length === 0) {
      open([]);
      return;
    }
    void liveTargets(candidates).then((targets) => {
      if (seq === requestSeq.current) open(targets);
    });
  };

  /**
   * The closing panes whose worktree create is genuinely STILL OUT — no `cwd`
   * yet, so `worktreeTargets` cannot see them, but one that lands after the
   * close would leave a directory behind.
   *
   * `error` is what separates them from the two look-alikes that also keep a
   * `provisioning` intent: a create that already failed (and rolled its own
   * directory back), and one interrupted by a quit and restored as a failed
   * card. Counting those made the checkbox promise to delete worktrees that do
   * not exist.
   */
  const pendingCreates = (panes: readonly Pane[]): string[] =>
    panes
      .filter((pane) => pane.provisioning && !pane.provisioning.error)
      .map((pane) => pane.id);

  const requestCloseAgent = (wsId: string, paneId: string, label: string) => {
    const ws = findWorkspace(deck.workspaces, wsId);
    const pendingPanes = pendingCreates(
      ws?.panes.filter((pane) => pane.id === paneId) ?? [],
    );
    // Read inside `make`, which `park` calls when the dialog actually OPENS —
    // one worktree probe later. Reading here would describe a pane the user
    // never saw a dialog for; the refs are what make "at open" true.
    park(ws ? worktreeTargets(ws, paneId, gitPositions) : [], (targets) => ({
      kind: "agent",
      wsId,
      paneId,
      label,
      pane: paneFactsOf(
        findPane(deckRef.current.workspaces, wsId, paneId),
        paneId in blockedRef.current,
      ),
      targets,
      pendingPanes,
    }));
  };

  const requestCloseWorkspace = (id: string) => {
    const ws = findWorkspace(deck.workspaces, id);
    if (!ws) return;
    const pendingPanes = pendingCreates(ws.panes);
    park(worktreeTargets(ws, undefined, gitPositions), (targets) => ({
      kind: "workspace",
      id,
      name: ws.name,
      count: ws.panes.length,
      targets,
      pendingPanes,
    }));
  };

  const confirmClose = () => {
    if (!closing) return;
    // The destructive choice is settled here and nowhere later: what the
    // dialog offered, against the box the user actually ticked.
    // The DECISION travels separately from the list. This list was frozen when
    // the dialog opened and cannot be complete — a create landing while the
    // user reads it owns a worktree nothing here has ever seen — so the close
    // finishes it against the live deck. What this list still contributes is
    // the observed branch per pane, which a bare pane read cannot give.
    const deleteWorktrees = deleteWorktree;
    const worktrees = deleteWorktree ? closing.targets : [];
    setClosing(null);
    setDeleteWorktree(false);
    void closeAgents(
      closing.kind === "agent"
        ? {
            kind: "agent",
            wsId: closing.wsId,
            paneId: closing.paneId,
            deleteWorktrees,
            worktrees,
          }
        : {
            kind: "workspace",
            wsId: closing.id,
            deleteWorktrees,
            worktrees,
          },
    ).then((failures) => {
      if (failures.length > 0)
        onError(
          `Failed to delete worktree${failures.length === 1 ? "" : "s"}:\n${failures.join("\n")}`,
        );
    });
  };

  const cancelClose = () => setClosing(null);

  /** Whether the dialog offers suspending instead of closing at all — from
   * the snapshot it opened with, so the button row cannot reshuffle
   * mid-gesture (see `ClosingTarget.pane`). A workspace close is deliberately
   * never offered it: "suspend" there would mean "don't close, park all N
   * agents" — a different verb on a different object, which a button sitting
   * inside "Close workspace?" cannot honestly say. */
  const canSuspendInstead = closing?.kind === "agent" && closing.pane.canSuspend;

  /** How many of a closing workspace's agents still hold a session. Live: a
   * workspace close names no pane, so there is nothing to have frozen, and
   * the count only ever shrinks toward the truth. */
  const runningAgentsOf = (target: ClosingTarget | null): number => {
    if (target?.kind !== "workspace") return 0;
    const ws = findWorkspace(deck.workspaces, target.id);
    // A session exists only behind a live process. `idle` of ANY reason means
    // there is none — including `waking`, which is a pane whose session is
    // still ahead of it — and a pane mid-create has never had one. Asking
    // "does it read as stopped" instead counted every rising pane as holding
    // a session it has not opened yet, which is what a just-launched
    // workspace is entirely made of.
    return (ws?.panes ?? []).filter(paneHasProcess).length;
  };

  const closeMessage = closeMessageFor(closing, runningAgentsOf(closing));

  /** How many worktrees the delete offer covers — the ones that exist plus the
   * creates still out. The dialog gates its checkbox on this rather than on
   * `targets`, which cannot see a pane mid-create. */
  const worktreeCount = closing
    ? closing.targets.length + closing.pendingPanes.length
    : 0;

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
    const { wsId, paneId } = closing;
    setClosing(null);
    setDeleteWorktree(false);
    // The dialog is already gone by the time this settles, so a refusal has
    // nowhere to appear unless it is surfaced here — this was the one caller
    // that dropped the outcome the other two turn into a sentence.
    const label = closing.label;
    void Promise.resolve(suspendAgent(wsId, paneId)).then((outcome) => {
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
    requestCloseWorkspace,
    confirmClose,
    cancelClose,
    canSuspendInstead,
    suspendInstead,
  };
}
