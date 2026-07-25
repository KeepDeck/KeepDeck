import { useRef, useState } from "react";
import {
  findPane,
  findWorkspace,
  idleReadsAsStopped,
  paneSuspendBlock,
  paneWakesAutomatically,
  worktreeTargets,
  type GitPosition,
  type WorktreeTarget,
} from "../domain/deck";
import { probeWorktree } from "../ipc/worktree";
import { clearPostProvision, discardWorktrees } from "./provisioning";
import { suspendRefusalText, type SuspendOutcome } from "./useSuspend";
import { closePanes } from "./ptyManager";
import { dropPaneSpawnSpec } from "./spawnSpecs";
import { clearPaneUsage } from "./usageManager";
import type { Deck } from "./useDeck";

/** A pending close awaiting confirmation ([U6]) — an agent pane or a whole
 * workspace. Closing tears down live PTY session(s) immediately, so both are
 * confirmed before they run. `targets` is the worktrees the close could also
 * delete (empty in non-worktree mode), snapshotted — and probed for
 * existence — at open time; the modal blocks all mutation, so it can't go
 * stale. */
export type ClosingTarget = { targets: WorktreeTarget[] } & (
  | {
      kind: "agent";
      wsId: string;
      paneId: string;
      label: string;
      /** Whether Suspend was on offer when this dialog opened, and whether
       * the pane read as stopped then — snapshotted with everything else it
       * shows, and for the same reason. Derived live, the offer could vanish
       * under the pointer: the revive sweep reporting a gone folder mid-
       * dialog removes the middle button, and the destructive Close slides
       * into the slot the user was already aiming at. Both facts travel
       * together so the sentence and the buttons cannot describe two
       * different panes. An offer that goes stale is harmless — `useSuspend`
       * re-checks at the click and refuses, where the refusal is now said. */
      canSuspend: boolean;
      isStopped: boolean;
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
  },
) {
  const {
    onError,
    onSuspendRefused,
    gitPositions,
    blockedPanes,
    suspendAgent,
  } = deps;
  const [closing, setClosing] = useState<ClosingTarget | null>(null);
  // Opt-in: also delete the closing target's worktree(s) + branch(es). Reset
  // each time the dialog opens so the destructive choice is never sticky.
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  // Close requests are numbered: target probing is async, and a slower
  // earlier request must not open its dialog over a newer one's.
  const requestSeq = useRef(0);

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

  const requestCloseAgent = (wsId: string, paneId: string, label: string) => {
    const ws = findWorkspace(deck.workspaces, wsId);
    const pane = findPane(deck.workspaces, wsId, paneId);
    const blocked = paneId in blockedPanes;
    const canSuspend = !!pane && paneSuspendBlock(pane, blocked) === null;
    const isStopped = !!pane && idleReadsAsStopped(pane.idle, blocked);
    park(ws ? worktreeTargets(ws, paneId, gitPositions) : [], (targets) => ({
      kind: "agent",
      wsId,
      paneId,
      label,
      canSuspend,
      isStopped,
      targets,
    }));
  };

  const requestCloseWorkspace = (id: string) => {
    const ws = findWorkspace(deck.workspaces, id);
    if (!ws) return;
    park(worktreeTargets(ws, undefined, gitPositions), (targets) => ({
      kind: "workspace",
      id,
      name: ws.name,
      count: ws.panes.length,
      targets,
    }));
  };

  const confirmClose = () => {
    if (!closing) return;
    const targets = deleteWorktree ? closing.targets : [];
    // Snapshot the pane ids before the reducer forgets them.
    const paneIds =
      closing.kind === "agent"
        ? [closing.paneId]
        : (deck.workspaces
            .find((w) => w.id === closing.id)
            ?.panes.map((p) => p.id) ?? []);
    // A closing workspace's plugin-owned resources (e.g. the Run plugin's
    // sessions) die through the plugin event bridge's onWorkspaceClosed —
    // no manual per-feature teardown here.
    for (const paneId of paneIds) {
      // Revoke bridge authentication before the reducer drops membership;
      // neither an in-flight reporter nor a reused pane id may write again.
      dropPaneSpawnSpec(paneId);
      clearPaneUsage(paneId);
      // A fork card abandoned instead of retried leaves its post-provision
      // step registered (kept across failure for Retry) — drop it on close.
      clearPostProvision(paneId);
    }
    if (closing.kind === "agent") deck.closeAgent(closing.wsId, closing.paneId);
    else deck.closeWorkspace(closing.id);
    setClosing(null);
    setDeleteWorktree(false);
    const closed = closePanes(paneIds);
    if (targets.length > 0) {
      void closed
        .then(() => discardWorktrees(targets))
        .then((failures) => {
          if (failures.length > 0)
            onError(
              `Failed to delete worktree${failures.length === 1 ? "" : "s"}:\n${failures.join("\n")}`,
            );
        });
    }
  };

  const cancelClose = () => setClosing(null);

  // The pane this dialog is about, when it is about one. A workspace close is
  // deliberately not offered the alternative: "suspend" there would mean
  // "don't close, park all N agents" — a different verb on a different object,
  // which a button sitting inside "Close workspace?" cannot honestly say.
  const closingPane =
    closing?.kind === "agent"
      ? findPane(deck.workspaces, closing.wsId, closing.paneId)
      : null;

  /** Whether the dialog should offer suspending instead of closing at all —
   * read from the snapshot it opened with, so the button row cannot reshuffle
   * mid-gesture (see `ClosingTarget.canSuspend`). */
  const canSuspendInstead = closing?.kind === "agent" && closing.canSuspend;

  /** The pane being closed has no process AND isn't coming back on its own —
   * the dialog must not promise to end a session that already ended, nor
   * claim one is stopped while it is starting up. The sweep's blocked verdict
   * counts: the same pane's tile and tray marker already read it as stopped,
   * and a dialog that disagreed with the tile beside it was the one surface
   * still calling a dead pane running. From the snapshot, like the offer. */
  const closingIsStopped = closing?.kind === "agent" && closing.isStopped;

  /**
   * What closing will actually do, in the dialog's own words. Built here
   * rather than at the prop because the three facts it needs — is the pane
   * stopped, may it be suspended, does it own a worktree — all live in this
   * hook, and spelling it out at the call site let the sentence drift from
   * what `confirmClose` does. It said the worktree "goes with it" while the
   * delete checkbox below it was, by default, unticked.
   */
  const closeMessage = ((): string => {
    if (!closing) return "";
    if (closing.kind === "workspace") {
      if (closing.count === 0) return "This workspace has no agents.";
      // Only the agents that still HAVE a session are counted as losing one —
      // the same correction the agent branch got, which this one was left
      // out of: a workspace of suspended agents ends nothing at all.
      const ws = findWorkspace(deck.workspaces, closing.id);
      const running = (ws?.panes ?? []).filter(
        (pane) => !idleReadsAsStopped(pane.idle, pane.id in blockedPanes),
      ).length;
      if (running === 0) {
        return closing.count === 1
          ? "Its agent is stopped; closing removes it."
          : "Its agents are stopped; closing removes them.";
      }
      return running === 1
        ? "This ends 1 agent and its session."
        : `This ends ${running} agents and their sessions.`;
    }
    // A pane still creating its worktree has never run, so there is no
    // session to end and no process to suspend.
    if (closingPane?.provisioning) return "Its worktree is still being created.";
    // A stopped pane has no session to end, and saying so would contradict
    // the card the user is looking at. Whether the worktree survives is the
    // checkbox's business, not this sentence's.
    if (closingIsStopped) return "It is stopped; closing removes the pane.";
    // Mutually exclusive with the branch above by construction: a stopped
    // pane is exactly the one `paneSuspendBlock` refuses.
    const alternative = canSuspendInstead
      ? closing.targets.length > 0
        ? "\nSuspending stops the agent instead, keeping the pane, its worktree and its session."
        : "\nSuspending stops the agent instead, keeping the pane and its session."
      : "";
    // A pane on its way up has no session YET — promising to end one, while
    // the line below offers to keep "its session", described a pane that
    // does not exist in either direction.
    const opening = paneWakesAutomatically(closingPane!)
      ? "It is starting up; closing removes the pane."
      : "Its terminal session will be ended.";
    return opening + alternative;
  })();

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
    deleteWorktree,
    setDeleteWorktree,
    requestCloseAgent,
    requestCloseWorkspace,
    confirmClose,
    cancelClose,
    canSuspendInstead,
    closingIsStopped,
    suspendInstead,
  };
}
