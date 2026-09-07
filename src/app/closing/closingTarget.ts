/**
 * What a confirmed close is about to end, frozen when the dialog opened.
 *
 * The model and the facts, apart from both the hook that parks them and the
 * sentence that describes them: all three change for different reasons — a
 * new kind of close, a new way of driving one, a rewording — and the copy has
 * a documented history of being corrected on its own.
 */
import {
  createIsOut,
  idleReadsAsStopped,
  paneSuspendBlock,
  paneWakesAutomatically,
  teamOfPane,
  type Pane,
  type Team,
  type Workspace,
  type WorktreeTarget,
} from "../../domain/deck";
import type { WorkspaceRef } from "../../domain/workspaceInstance";

export type CarrierNote = { kind: "background" } | { kind: "unknown" };

/** A team's worktree, as a close could take it: the directories that
 * exist, snapshotted — and probed for existence — at open time, and
 * whether the team's create is still genuinely OUT. A team mid-create has
 * no directory yet, so `targets` cannot describe it — but a create that
 * lands after the close leaves a directory and branch nothing will ever
 * name again, so the offer has to cover it; what it actually made is only
 * known once it settles. */
export interface TeamTeardownOffer {
  targets: WorktreeTarget[];
  /** How many of the teams' creates are still out — each one a worktree
   * the offer covers without being able to name. */
  pending: number;
}

/** A pending close awaiting confirmation ([U6]) — an agent, a team, or a
 * whole workspace. Closing tears down live PTY session(s) immediately, so
 * all three are confirmed before they run. The modal blocks all mutation,
 * so what it snapshotted can't go stale. */
export type ClosingTarget =
  | {
      kind: "agent";
      workspace: WorkspaceRef;
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
      /** The team this pane is the LAST member of, when it is. The dialog
       * then speaks two verbs: disbanding the team (the primary — with its
       * worktree on offer) and closing the agent alone (the team and its
       * directory stay). Null for a member with company, or a pane on no
       * team: closing one of those is never asked about a directory. */
      last: (TeamTeardownOffer & { teamId: string; name: string }) | null;
    }
  | ({
      kind: "team";
      workspace: WorkspaceRef;
      teamId: string;
      name: string;
      count: number;
    } & TeamTeardownOffer)
  | ({
      kind: "workspace";
      workspace: WorkspaceRef;
      name: string;
      count: number;
    } & TeamTeardownOffer);

/** The pane as the dialog found it, frozen when the dialog opened. */
export interface ClosingPaneFacts {
  /** The pane's team's worktree create is still in flight — it has never run. */
  provisioning: boolean;
  /** On its way up: no session YET, as opposed to none any more. */
  rising: boolean;
  /** Reads as stopped to the user (see `idleReadsAsStopped`). */
  stopped: boolean;
  /** Suspend is on offer. */
  canSuspend: boolean;
}

/** Read the pane's facts as one set, so no caller can take half of them. */
export function paneFactsOf(
  ws: Workspace | undefined,
  pane: Pane | undefined,
  blocked: boolean,
): ClosingPaneFacts {
  const placed = ws && pane;
  return {
    provisioning: !!placed && teamOfPane(ws, pane)?.location?.kind === "provisioning",
    rising: !!pane && paneWakesAutomatically(pane),
    stopped: !!pane && idleReadsAsStopped(pane.idle, blocked),
    canSuspend: !!placed && paneSuspendBlock(ws, pane, blocked) === null,
  };
}

/**
 * The teams whose worktree create is genuinely STILL OUT — no directory
 * yet, so `worktreeTargets` cannot see them, but one that lands after the
 * close would leave a directory behind.
 *
 * `error` is what separates them from the two look-alikes that also keep a
 * `provisioning` intent: a create that already failed (and rolled its own
 * directory back), and one interrupted by a quit and restored as a failed
 * card. Counting those made the checkbox promise to delete worktrees that do
 * not exist.
 */
export function pendingCreates(teams: readonly Team[]): number {
  return teams.filter((team) => createIsOut(team.location)).length;
}
