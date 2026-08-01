/**
 * One owner for a pane's git worktree: creating it, publishing what landed,
 * and tearing it down again.
 *
 * Why an owner and not a handful of module functions — the ORDER between these
 * operations is a real invariant, and until now nothing was in a position to
 * state it. Creating a worktree arms the workspace's staged skills inside it;
 * removing one deletes the directory. Those two ran from different places (a
 * spawn plan and a close flow) with no coordination between them, so an arming
 * could land inside git's recursive delete and leave behind a directory git
 * would no longer even recognise. Everything that touches a pane's worktree
 * goes through this object, so that ordering is enforceable in one place
 * instead of agreed upon across four files.
 *
 * The state here is per-instance on purpose: the maps below used to be module
 * globals that outlived a test's `clearAllMocks`, and a lifetime nobody owns is
 * exactly the shape of bug this module exists to prevent.
 */
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import type { Pane, WorktreeTarget } from "../../domain/deck";
import type { SkillsStagingViews } from "../../ipc/skills";
import type { ProvisionCallbacks, SetupStep } from "../provisioning";
import { createWorktreeProvisioning } from "./provisioning";
import { createOrderQueue } from "./queue";
import { createSkillsStaging } from "./staging";
import { createWorktreeTeardown } from "./teardown";

/** A worktree a create put on disk: enough for [`WorktreeManager.remove`]. */
export interface CreatedWorktree {
  repo: string;
  path: string;
  branch: string;
}

/** One workspace as the sweep sees it: its durable id (the key its staged dirs
 * live under) and the spawn cwds currently claimed by its panes. */
export interface LiveWorkspace {
  id: string;
  roots: string[];
}

/**
 * The deck as this manager reads it — the ONE source for which directories are
 * live spawn roots. Arming a root and sweeping a dead one used to derive that
 * set independently, from two snapshots taken at different moments, and the
 * disagreement is what armed a directory that was being deleted.
 */
export interface WorktreeDeckView {
  /** The workspace's live spawn roots; empty when it is gone. */
  rootsOf(workspace: WorkspaceRef): string[];
  /** Every live workspace with its roots. */
  live(): LiveWorkspace[];
}

/**
 * What the pane lifecycle needs: creating worktrees, naming what landed, and
 * tearing them down again — plus the staged skills a spawn plan asks for, since
 * arming a directory and deleting it are the pair whose ORDER is the invariant.
 */
export interface WorktreeProvisioner {
  /**
   * Create the worktrees behind `panes`' provisioning cards, reporting each
   * result as it lands (completion order is whatever the per-repo lock hands
   * out — the deck shows panes coming alive as they're ready). One base commit
   * is pinned for the whole batch so concurrent creates don't straddle a moving
   * HEAD; a pane whose intent carries its own picked `base` forks from that
   * instead. Panes without an intent are ignored, so a retry can pass one pane
   * and the batch flows can pass them all. Never throws: a failure lands on its
   * pane's card via `onFailed`.
   *
   * `setup` is the workspace's one-time preparation command: it runs in each
   * created worktree before the pane resolves, and a failure ROLLS THE WORKTREE
   * BACK (so Retry re-creates from scratch instead of hitting "already exists")
   * and lands on the card with the output tail.
   */
  provision(
    panes: Pane[],
    report: ProvisionCallbacks,
    setup?: SetupStep,
  ): Promise<void>;
  /**
   * What `paneId`'s create made, waiting for the `git worktree add` to return
   * if it has not yet. Null when there is nothing outstanding — the pane
   * already owns its worktree (so it has a `cwd` to be named by), or its create
   * failed and rolled back, or it never had one.
   */
  awaitCreated(paneId: string): Promise<CreatedWorktree | null>;
  /** Register a step to run after `paneId`'s worktree lands (see the map doc). */
  registerPostProvision(
    paneId: string,
    step: (worktree: { cwd: string; branch: string }) => Promise<void>,
  ): void;
  /** Forget a pane's post-provision step (the fork was abandoned before it ran). */
  clearPostProvision(paneId: string): void;
  /**
   * The workspace's staged shared skills, ready for a spawn plan — and, as a
   * side effect, its live spawn roots armed with the codex-facing
   * `.agents/skills` symlink. `null` = nothing to inject (an empty library, or
   * a staging that failed and was degraded by the IPC layer): panes then spawn
   * without skills rather than re-hitting a broken backend.
   *
   * The roots come from the deck, never from the caller: a build path that
   * passed its own snapshot is how a directory being deleted got armed.
   * `landing` is the one honest exception — a pane about to exist in a cwd the
   * deck does not list yet — and it is a cwd, not a set.
   *
   * Memoized per workspace INSTANCE and root set: staging rebuilds the on-disk
   * views from the library, so it runs once and every later pane spawn in that
   * workspace reuses the promise. Ids may be reused after a close, instances
   * never are, so a reborn id cannot be served a dead lifetime's promise (whose
   * dirs the sweep may have deleted). The DISK key stays the durable id.
   */
  skillsFor(
    workspace: WorkspaceRef,
    landing?: string,
  ): Promise<SkillsStagingViews | null>;
  /**
   * Tear down each target's git worktree and branches when the close dialog's
   * delete checkbox was ticked. Always forced — the checkbox is explicit
   * intent, so a dirty worktree / unmerged branch is discarded per the user's
   * decision; the same intent covers every branch the agent CREATED in the
   * worktree, not just the tracked one (side branches would otherwise pile up
   * dead). Never throws: a failing target is collected so one bad worktree
   * doesn't strand the rest, and the messages surface in the error dialog.
   */
  remove(targets: WorktreeTarget[]): Promise<string[]>;
}

/** What the deck's housekeeping needs — nothing else. */
export interface WorktreeHousekeeping {
  /**
   * Drop what no live workspace claims any more: the derived skill dirs of
   * workspaces that are gone, and the `.agents/skills` arming of spawn cwds
   * that left. Called on every deck transition, since any of them can shrink the
   * live set, and once the deck has hydrated at boot (which catches whatever a
   * crash or an update left behind).
   *
   * `deckHydrated` is a fact only the caller has; every DECISION is made here.
   * Sweeping a deck that is still loading reads as "no workspaces exist" and
   * would delete every live dir, so this refuses rather than trusting each call
   * site to remember — and a transition that changes nothing it acts on costs no
   * IPC at all.
   */
  sweep(deckHydrated: boolean): Promise<void>;
}

/** What the skills editor needs: a way to say the library moved. */
export interface SkillsInvalidation {
  /** The library changed (any scope): every workspace re-stages on its next
   * spawn. Editing is rare and staging is cheap — no finer bookkeeping. */
  invalidateSkills(): void;
}

/**
 * The whole owner, as the composition root builds it. Consumers take the role
 * they need instead of this: the orchestrator has no business with `sweep`, the
 * sweep trigger has none with provisioning, and a fake that has to stub methods
 * its subject never calls is a fake that stops catching anything.
 */
/** The one queue that orders everything KeepDeck plants in a pane's cwd
 * against the removal of that cwd. Exposed as its own role because the MCP
 * injection plants a file of its own and must take the same slot — running it
 * outside this queue is exactly the arming-inside-a-teardown bug the owner
 * exists to prevent. */
export interface WorktreeOrdering {
  inOrder<T>(work: () => Promise<T>): Promise<T>;
}

export type WorktreeManager = WorktreeProvisioner &
  WorktreeHousekeeping &
  SkillsInvalidation &
  WorktreeOrdering;

export function createWorktreeManager(deck: WorktreeDeckView): WorktreeManager {
  const inOrder = createOrderQueue();
  const staging = createSkillsStaging(deck, inOrder);
  const teardown = createWorktreeTeardown(inOrder, staging.disarm);
  const provisioning = createWorktreeProvisioning(inOrder, teardown.rollback);

  return {
    inOrder,
    ...provisioning,
    skillsFor: staging.skillsFor,
    invalidateSkills: staging.invalidateSkills,
    sweep: staging.sweep,
    remove: teardown.remove,
  };
}
