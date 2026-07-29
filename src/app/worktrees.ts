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
import type { Pane, PaneProvisioning, WorktreeTarget } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { createWorktree, inspectRepo, removeWorktree } from "../ipc/worktree";
import type { ProvisionCallbacks, SetupStep } from "./provisioning";

/** A worktree a create put on disk: enough for [`WorktreeManager.remove`]. */
export interface CreatedWorktree {
  repo: string;
  path: string;
  branch: string;
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

export function createWorktreeManager(): WorktreeManager {
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

  /** Best-effort teardown of a half-prepared worktree so Retry re-creates
   * cleanly instead of hitting "already exists"; a failing remove leaves the
   * card error as the source of truth. */
  async function rollbackWorktree(
    repo: string,
    rec: { path: string; branch: string },
  ): Promise<void> {
    await removeWorktree(repo, rec.path, {
      force: true,
      branch: rec.branch,
    }).catch((e) =>
      log.warn(
        "web:worktrees",
        `worktree rollback failed for ${rec.path}: ${describeError(e)}`,
      ),
    );
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

    async remove(targets) {
      const failures: string[] = [];
      for (const t of targets) {
        try {
          await removeWorktree(t.repo, t.path, {
            force: true,
            branch: t.branch,
            reapCreatedBranches: true,
          });
        } catch (e) {
          log.warn(
            "web:worktrees",
            `worktree removal failed for ${t.path}: ${describeError(e)}`,
          );
          failures.push(`${t.branch ?? t.path}: ${e}`);
        }
      }
      return failures;
    },
  };
}
