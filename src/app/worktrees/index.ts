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
 * Vocabulary: worktrees are INFRASTRUCTURE — the pane-directory owner — while
 * skills are the CAPABILITY PLATFORM. Features meet this owner at ports, and
 * runtime.ts is the composition root that wires them; keeping those nouns
 * explicit prevents an infrastructure/feature dependency from looking like a
 * harmless convenience import.
 *
 * The state here is per-instance on purpose: the maps below used to be module
 * globals that outlived a test's `clearAllMocks`, and a lifetime nobody owns is
 * exactly the shape of bug this module exists to prevent.
 */
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import {
  skillRootsOf,
  type Pane,
  type Workspace,
  type WorktreeTarget,
} from "../../domain/deck";
import type { ProvisionCallbacks, SetupStep } from "../provisioning";
import { createWorktreeProvisioning } from "./provisioning";
import { createOrderQueue, type InOrder } from "./queue";
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

/** The three staged directory views the spawn hook may consume. Kept as this
 * infrastructure port rather than importing the skills feature's IPC DTO: the
 * manager owns the lifetime and ordering, while the feature owns the wire. */
export interface WorktreeSkillViews {
  claudePluginDir: string;
  opencodeConfigDir: string;
  skillsDir: string;
}

/** The planting result the MCP feature reports through the infrastructure
 * port. Structural typing keeps the IPC DTO private to that feature. */
export interface McpPlantingReport {
  armed: string[];
  refused: { root: string; reason: string }[];
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
  ): Promise<WorktreeSkillViews | null>;
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

/** What the skills LIBRARY needs from this manager: a way to say the library
 * moved. Held by `skillsLibrary`, which reports it after every successful write
 * — the editor reaches it only through that owner. */
export interface SkillsInvalidation {
  /** The library changed (any scope): every workspace re-stages on its next
   * spawn. Editing is rare and staging is cheap — no finer bookkeeping. */
  invalidateSkills(): void;
}

/**
 * The other thing KeepDeck plants in a pane's cwd: the MCP client config a
 * file-fed CLI reads instead of taking servers on argv.
 *
 * Its own role rather than a shared queue handle, because ordering against a
 * teardown is only HALF of what makes such a write safe — the other half is
 * refusing a directory no live pane claims any more, and both halves are this
 * owner's knowledge. Handing out the queue instead let the MCP path take the
 * ordering and skip the check.
 *
 * WHAT to write stays the MCP owner's business; this decides where it is
 * allowed to land, and when.
 */
export interface McpPlanting {
  /** Put `content` in `root` for `workspaceId`, once nothing else is touching
   * that directory. Reports what landed and what refused (a cwd where the user
   * keeps their own config, one that is gone, one it cannot write); never
   * throws. */
  plantMcp(
    workspaceId: string,
    root: string,
    content: string,
  ): Promise<McpPlantingReport>;
  /** Take our MCP configs back out of `roots` — every one of them, live or
   * not: this is the transport going down, not a directory leaving. */
  retractMcp(roots: string[]): Promise<boolean>;
}

/**
 * The whole owner, as the composition root builds it. Consumers take the role
 * they need instead of this: the orchestrator has no business with `sweep`, the
 * sweep trigger has none with provisioning, and a fake that has to stub methods
 * its subject never calls is a fake that stops catching anything.
 */
export type WorktreeManager = WorktreeProvisioner &
  WorktreeHousekeeping &
  SkillsInvalidation &
  McpPlanting;

/** The one composite passed into the manager. Its factories receive the
 * manager's queue, so every planting shares exactly one ordering guard. */
export interface WorktreePlantingFactories {
  skills(
    deck: WorktreeDeckView,
    inOrder: InOrder,
  ): WorktreeSkillsPlanting;
  mcp(inOrder: InOrder): McpPlanting;
}

export interface WorktreeSkillsPlanting
  extends Pick<WorktreeProvisioner, "skillsFor">,
    SkillsInvalidation {
  /** Forget the stagings that armed any of `roots`. */
  forgetStaged(roots: string[]): void;
}

export interface WorktreePlantings
  extends Pick<WorktreeProvisioner, "skillsFor">,
    McpPlanting,
    WorktreeHousekeeping,
    SkillsInvalidation {
  /** Teardown's single home for undoing both plantings. */
  disarm(roots: string[]): Promise<boolean>;
}

export type WorktreePlantingsFactory = (
  deck: WorktreeDeckView,
  inOrder: InOrder,
) => WorktreePlantings;

/**
 * The deck view over a live snapshot — the one projection of "which
 * directories does this workspace claim".
 *
 * Here rather than assembled at the composition root: the LIFETIME match is
 * load-bearing (ids are reusable, instances are not, so a reborn workspace
 * must never be handed the dead one's roots) and it was stated only in a
 * closure with no test, while the worktree suites' fake re-implemented it
 * correctly on their own. A regression in the real one would have broken
 * nothing that runs.
 */
export function deckViewOf(workspaces: () => Workspace[]): WorktreeDeckView {
  return {
    rootsOf: (ref) => {
      const workspace = workspaces().find(
        (candidate) =>
          candidate.id === ref.id && candidate.instance === ref.instance,
      );
      return workspace ? skillRootsOf(workspace) : [];
    },
    live: () =>
      workspaces().map((workspace) => ({
        id: workspace.id,
        roots: skillRootsOf(workspace),
      })),
  };
}

export function createWorktreeManager(
  deck: WorktreeDeckView,
  createPlantings: WorktreePlantingsFactory,
): WorktreeManager {
  const inOrder = createOrderQueue();
  const plantings = createPlantings(deck, inOrder);
  const teardown = createWorktreeTeardown(inOrder, plantings.disarm);
  const provisioning = createWorktreeProvisioning(inOrder, teardown.rollback);

  return {
    ...provisioning,
    skillsFor: plantings.skillsFor,
    invalidateSkills: plantings.invalidateSkills,
    sweep: plantings.sweep,
    plantMcp: plantings.plantMcp,
    retractMcp: plantings.retractMcp,
    remove: teardown.remove,
  };
}
