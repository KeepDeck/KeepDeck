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
import type { Pane, PaneProvisioning, WorktreeTarget } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import {
  disarmSkills,
  pruneSkills,
  stageSkills,
  type SkillsStagingViews,
} from "../ipc/skills";
import { createWorktree, inspectRepo, removeWorktree } from "../ipc/worktree";
import type { ProvisionCallbacks, SetupStep } from "./provisioning";

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

/** What a pane's worktree needs from its owner. */
export interface WorktreeManager {
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
  /** The library changed (any scope): every workspace re-stages on its next
   * spawn. Editing is rare and staging is cheap — no finer bookkeeping. */
  invalidateSkills(): void;
  /**
   * Drop what no live workspace claims any more: the derived skill dirs of
   * workspaces that are gone, and the `.agents/skills` arming of spawn cwds
   * that left. Called on every deck transition that can shrink the live set —
   * a pane or workspace closing, a directory found missing, and once the deck
   * has hydrated at boot (which catches whatever a crash or an update left).
   *
   * `deckHydrated` is a fact only the caller has, and the DECISION is made
   * here: sweeping a deck that is still loading reads as "no workspaces exist"
   * and would delete every live dir, so this refuses rather than trusting each
   * call site to remember. Bursts coalesce — a workspace closing six panes
   * sweeps once.
   */
  sweep(deckHydrated: boolean): Promise<void>;
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

export function createWorktreeManager(deck: WorktreeDeckView): WorktreeManager {
  /**
   * Post-provision steps, keyed by pane id: a JS step run AFTER a pane's
   * worktree is created (and setup passed) but BEFORE its card resolves — the
   * seam where a journal fork runs its store surgery bound to the CREATED
   * worktree. It runs on the initial create AND on every Retry (both go through
   * `provisionPane`), so a retried fork re-runs its surgery instead of silently
   * resolving into a plain (non-fork) pane. A step THROWS to fail (the worktree
   * is rolled back and the card fails); it is consumed once it succeeds, and
   * kept across a failed attempt so the retry re-runs it.
   *
   * PERSISTENCE COUPLING (don't miss this): a step lives ONLY in this in-memory
   * map — it cannot survive an app restart. So ANY pane that registers a step
   * MUST also be excluded from persistence, or its card restores as a plain
   * retryable card and Retry resolves a NON-fork pane. The journal fork does
   * this via `PaneProvisioning.fork`, which `serializeDeck` drops; a future
   * second user of this map must add the equivalent.
   */
  const postProvisionSteps = new Map<
    string,
    (worktree: { cwd: string; branch: string }) => Promise<void>
  >();

  /**
   * What each pane's worktree create has put on disk, published the moment
   * `git worktree add` returns and BEFORE anything else the create does.
   *
   * Published early on purpose. The close needs two things a create cannot give
   * it at the same moment: the path, and permission to delete only after the
   * pane's process is reaped. Waiting for the whole create supplies neither —
   * the setup step runs in the session slot the close just reaped, so waiting
   * there is a deadlock — and letting the CREATE delete supplies the path but
   * loses the ordering, removing a directory a still-live setup command is
   * writing into.
   *
   * Publishing at the git call splits those apart: this promise always settles
   * promptly (nothing but the git call is in front of it), so the close can
   * await it, then reap, then delete — in that order, with `remove` doing the
   * removal and reporting its failures like any other.
   *
   * Kept until READ, then dropped. The pane also drops its own entry once it
   * takes ownership (`onResolved`), because from then on it has a `cwd` and the
   * close can name the worktree without help.
   */
  const created = new Map<string, Promise<CreatedWorktree | null>>();

  /** In-flight and completed stagings, keyed by workspace instance + root set
   * (see [`WorktreeManager.skillsFor`]). A `null` result is remembered too. The
   * roots ride along because a teardown has to find the entries that stood for
   * the arming it just undid — see [`forgetStaged`]. */
  const staged = new Map<
    string,
    { roots: string[]; views: Promise<SkillsStagingViews | null> }
  >();

  /** The deck as the last sweep acted on it — what the next one diffs against to
   * find the roots that left — and whether any sweep has run at all. The flag is
   * not redundant: a deck that boots EMPTY compares equal to the initial value,
   * and that first pass is exactly the one that clears what a crash left. */
  let swept: LiveWorkspace[] = [];
  let sweptOnce = false;

  /** The sweep in flight, if any, and whether another was asked for while it
   * ran. A close of six panes fires six transitions; one pass over the same
   * directories answers all of them. */
  let sweeping: Promise<void> | null = null;
  let sweepAgain = false;

  /**
   * The one queue that orders arming against teardown.
   *
   * THE invariant this module exists for: staging arms every live spawn root
   * with a `.agents/skills` symlink, and a removal deletes a root's whole
   * directory. Run concurrently, an arming lands between git's recursive delete
   * and its final `rmdir`, which then fails on a directory that is no longer a
   * worktree — an orphaned branch and a husk nothing can clear. Because both
   * sides pass through here, the ordering is a property of this object rather
   * than a convention its callers have to keep.
   *
   * One queue for all workspaces, deliberately: staging is a directory copy and
   * a removal is a user closing panes, so nothing here is hot enough to split,
   * and a finer queue would have to know which repository a root belongs to —
   * knowledge that lives a layer down, in git.
   */
  let queue: Promise<unknown> = Promise.resolve();

  /** Run `work` after everything already queued. A failure inside `work` is the
   * caller's to handle and must not stall the queue for everyone else. */
  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  }

  /** Run the registered step, if any. Returns null on success (or when none is
   * registered — a plain pane) and the failure message otherwise; a successful
   * step is consumed, a failed one is KEPT so a Retry re-runs it. */
  async function runPostProvision(
    paneId: string,
    worktree: { cwd: string; branch: string },
  ): Promise<string | null> {
    const step = postProvisionSteps.get(paneId);
    if (!step) return null;
    try {
      await step(worktree);
      postProvisionSteps.delete(paneId);
      return null;
    } catch (e) {
      return describeError(e);
    }
  }

  /** Which spawn cwds no live workspace claims any more — the one rule that
   * covers a closed pane, a closed workspace and a doomed worktree alike. */
  function unclaimed(candidates: string[], live: LiveWorkspace[]): string[] {
    const claimed = new Set(live.flatMap((ws) => ws.roots));
    return [...new Set(candidates)].filter((root) => !claimed.has(root));
  }

  /** Drop every memoized staging whose root set covers one of `roots`.
   *
   * The memo caches the RESULT of a call whose SIDE EFFECT was arming those
   * directories, so disarming one has to invalidate it. Without this, a root
   * that leaves and comes back — the default when a pane is deleted and a new
   * one takes the freed folder — is served a cache hit, `stageSkills` never
   * runs again, and the new worktree silently has no `.agents/skills`. */
  function forgetStaged(roots: string[]): void {
    if (roots.length === 0) return;
    const dropped = new Set(roots);
    for (const [key, entry] of staged) {
      if (entry.roots.some((root) => dropped.has(root))) staged.delete(key);
    }
  }

  /** What the live set looks like, for "has anything I act on changed?".
   * Deliberately here and nowhere else: a second projection of the same
   * question, in a React hook, is how the trigger and the answer came to
   * disagree. */
  function liveFingerprint(live: LiveWorkspace[]): string {
    return JSON.stringify(
      live.map((ws) => [ws.id, [...ws.roots].sort()]).sort(),
    );
  }

  /** One pass of the sweep: disarm the roots that left, forget the stagings that
   * armed them, then drop the derived dirs of workspaces that are gone. Runs in
   * the queue for the same reason a removal does — the disarm here is a teardown
   * — and both IPCs are best-effort, since housekeeping must never break a
   * close. */
  function sweepOnce(): Promise<void> {
    return inOrder(async () => {
      const live = deck.live();
      const departed = unclaimed(
        swept.flatMap((ws) => ws.roots),
        live,
      );
      await disarmSkills(departed);
      forgetStaged(departed);
      swept = live;
      sweptOnce = true;
      // Re-read for the PRUNE: the list that decides what to delete must not be
      // one IPC round trip old, or a workspace created while the disarm was in
      // flight is pruned as dead and its panes spawn pointing at deleted dirs.
      await pruneSkills(deck.live().map((ws) => ws.id).sort());
    });
  }

  /**
   * Tear ONE worktree down: our own hooks out of the directory, the stagings
   * that armed it forgotten, then git.
   *
   * Every teardown goes through here — a close's removal and a half-prepared
   * create's rollback alike. Two paths doing this by hand is what let an arming
   * land inside a `git worktree remove`, and a rollback that skipped the disarm
   * was the same divergence in miniature.
   *
   * One queue slot PER TARGET, not per call: the guarantee is per directory, and
   * holding one slot across a whole workspace's teardown stalled spawn-plan
   * builds in unrelated workspaces for the length of N forced git removals.
   *
   * Returns the user-facing message when git refused, `null` on success.
   */
  function teardown(
    target: WorktreeTarget,
    reapCreatedBranches: boolean,
  ): Promise<string | null> {
    return inOrder(async () => {
      // A cwd another LIVE workspace still runs a pane in stays armed: two
      // workspaces may legitimately share a directory, and the arming is keyed
      // by path, not by workspace. Same rule the sweep applies.
      await disarmSkills(unclaimed([target.path], deck.live()));
      forgetStaged([target.path]);
      try {
        await removeWorktree(target.repo, target.path, {
          force: true,
          branch: target.branch,
          reapCreatedBranches,
        });
        return null;
      } catch (e) {
        log.warn(
          "web:worktrees",
          `worktree removal failed for ${target.path}: ${describeError(e)}`,
        );
        return `${target.branch ?? target.path}: ${e}`;
      }
    });
  }

  /** Best-effort teardown of a half-prepared worktree so Retry re-creates
   * cleanly instead of hitting "already exists"; a failing remove leaves the
   * card error as the source of truth. The agent's own side branches are NOT
   * reaped here — this worktree never became a pane's, so nothing was born in
   * it that a close would sweep. */
  async function rollbackWorktree(
    repo: string,
    rec: { path: string; branch: string },
  ): Promise<void> {
    const failure = await teardown(
      { repo, path: rec.path, branch: rec.branch },
      false,
    );
    if (failure) {
      log.warn("web:worktrees", `worktree rollback failed: ${failure}`);
    }
  }

  /**
   * One pane's create (+ optional setup) → its card resolves or fails.
   *
   * What it puts on disk is published the instant `git worktree add` returns
   * (see [`created`]), so a close can name the directory without waiting for
   * the rest of this. Nothing here deletes on a close's behalf: this function
   * only stops early, and the close does the removing in the order it needs.
   */
  async function provisionPane(
    paneId: string,
    intent: PaneProvisioning,
    batchBase: { commit?: string; branch?: string } | undefined,
    cb: ProvisionCallbacks,
    setup?: SetupStep,
  ): Promise<void> {
    /**
     * The pane left while we were working. Asked after every await that could
     * outlive it, because everything past the create is done ON ITS BEHALF: a
     * setup command would spawn into a session slot the close already reaped,
     * and `onResolved` would hand a worktree to a pane that cannot take it.
     * Whether that worktree then goes is the close's decision, not ours — it is
     * the only party that knows what the user ticked and when the process died.
     */
    const abandoned = (): boolean => {
      if (!cb.abandoned(paneId)) return false;
      log.info(
        "web:worktrees",
        `${paneId} left while its worktree was being created — stopping here`,
      );
      return true;
    };

    let publish!: (made: CreatedWorktree | null) => void;
    created.set(
      paneId,
      new Promise<CreatedWorktree | null>((resolve) => {
        publish = resolve;
      }),
    );

    let rec: { path: string; branch: string };
    try {
      rec = await createWorktree({
        repo: intent.repo,
        baseDir: intent.baseDir ?? "",
        agentId: paneId,
        branch: intent.branch,
        // The user's picked base branch outranks the batch-pinned HEAD.
        base: intent.base ?? batchBase?.commit,
        ...(!intent.base && batchBase?.branch && { baseBranch: batchBase.branch }),
        workspace: intent.workspace,
        index: intent.index,
        path: intent.path,
      });
    } catch (e) {
      log.error(
        "web:worktrees",
        `worktree create failed for ${paneId}: ${describeError(e)}`,
      );
      // Nothing landed, so a close has nothing to remove.
      publish(null);
      created.delete(paneId);
      cb.onFailed(paneId, describeError(e));
      return;
    }
    // The directory exists: say so before anything else can delay it. A close
    // racing this is the case the early publish is for.
    publish({ repo: intent.repo, path: rec.path, branch: rec.branch });
    // Before the setup command, not only after: it runs in the pane's session
    // slot, and spawning there once the pane is gone leaves a process with
    // nothing to reap it.
    if (abandoned()) return;

    if (setup) {
      cb.onSetup?.(paneId);
      const result = await setup(paneId, { cwd: rec.path, branch: rec.branch });
      // Asked BEFORE the result is judged. A pane closed mid-setup ends the
      // command, so it comes back not-ok — but that is the close, not a broken
      // setup, and the failure branch below would roll back a worktree whose
      // fate is the close's to decide.
      if (abandoned()) return;
      if (!result.ok) {
        log.error(
          "web:worktrees",
          `setup failed for ${paneId} in ${rec.path}: ${result.tail}`,
        );
        await rollbackWorktree(intent.repo, rec);
        // Rolled back, so there is nothing left for a close to remove.
        created.delete(paneId);
        cb.onFailed(paneId, `Setup failed: ${result.tail}`);
        return;
      }
    }

    // The worktree is on disk — run any registered post-provision step (a
    // journal fork's store surgery, bound to the CREATED worktree). A failure
    // rolls the worktree back and fails the card; the step stays registered, so
    // Retry re-runs it rather than resolving into a plain (non-fork) pane.
    const stepError = await runPostProvision(paneId, {
      cwd: rec.path,
      branch: rec.branch,
    });
    if (stepError !== null) {
      log.error(
        "web:worktrees",
        `post-provision step failed for ${paneId} in ${rec.path}: ${stepError}`,
      );
      await rollbackWorktree(intent.repo, rec);
      created.delete(paneId);
      cb.onFailed(paneId, stepError);
      return;
    }
    // The last gate, with no await between it and the handover: past here the
    // pane owns the worktree and an ordinary close can name it by its `cwd`, so
    // the published entry is no longer anyone's only handle on it.
    if (abandoned()) return;
    created.delete(paneId);

    cb.onResolved(paneId, { cwd: rec.path, branch: rec.branch });
  }

  return {
    async provision(panes, cb, setup) {
      const pending = panes.filter((p) => p.provisioning);
      if (pending.length === 0) return;

      let batchBase: { commit?: string; branch?: string } | undefined;
      try {
        const inspected = await inspectRepo(pending[0].provisioning!.repo);
        batchBase = {
          ...(inspected.head && { commit: inspected.head }),
          ...(inspected.branch && { branch: inspected.branch }),
        };
      } catch {
        batchBase = undefined; // create resolves HEAD itself when base is omitted
      }

      await Promise.all(
        pending.map((p) =>
          provisionPane(p.id, p.provisioning!, batchBase, cb, setup),
        ),
      );
    },

    awaitCreated(paneId) {
      const pending = created.get(paneId);
      if (!pending) return Promise.resolve(null);
      created.delete(paneId);
      return pending;
    },

    registerPostProvision(paneId, step) {
      postProvisionSteps.set(paneId, step);
    },

    clearPostProvision(paneId) {
      postProvisionSteps.delete(paneId);
    },

    skillsFor(workspace, landing) {
      const roots = [
        ...new Set([...deck.rootsOf(workspace), ...(landing ? [landing] : [])]),
      ].sort();
      // A JSON array as the memo key: injective for any path, with no reliance
      // on a separator byte that paths are merely assumed not to contain.
      const key = JSON.stringify([workspace.instance, ...roots]);
      const memoized = staged.get(key);
      if (memoized) return memoized.views;
      // Queued: a staging that started while a teardown is in flight would arm
      // the very directory being deleted (see [`queue`]).
      const views = inOrder(() => {
        // Re-checked at EXECUTION time. A root can only have left while this
        // waited — the teardown that removed it ran in this same queue — and
        // arming a directory that is gone is the mistake this owner exists to
        // prevent. The `landing` cwd is exempt: the deck cannot see a pane that
        // has not landed yet. A later call sees the smaller set, keys on it and
        // stages afresh, so nothing is lost by narrowing here.
        const claimed = new Set(deck.rootsOf(workspace));
        const armable = roots.filter(
          (root) => claimed.has(root) || root === landing,
        );
        return stageSkills(workspace.id, armable);
      });
      staged.set(key, { roots, views });
      return views;
    },

    invalidateSkills() {
      staged.clear();
    },

    async sweep(deckHydrated) {
      if (!deckHydrated) return;
      // Called on every deck transition, so the cheap comparison is what keeps a
      // rename or a pane reorder from costing two IPC round trips. The first
      // pass always runs: it is the one that clears what a crash left behind.
      if (sweptOnce && liveFingerprint(swept) === liveFingerprint(deck.live())) {
        return;
      }
      if (sweeping) {
        // Someone already asked; that pass may already have read the deck, so
        // one more after it covers this request too.
        sweepAgain = true;
        return sweeping;
      }
      sweeping = (async () => {
        try {
          await sweepOnce();
          while (sweepAgain) {
            sweepAgain = false;
            await sweepOnce();
          }
        } finally {
          sweeping = null;
          sweepAgain = false;
        }
      })();
      return sweeping;
    },

    async remove(targets) {
      const failures: string[] = [];
      for (const target of targets) {
        const failure = await teardown(target, true);
        if (failure) failures.push(failure);
      }
      return failures;
    },
  };
}
