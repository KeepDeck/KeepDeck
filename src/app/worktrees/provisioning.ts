/**
 * Creating the worktrees behind provisioning cards, and publishing what
 * landed.
 *
 * The one subtlety worth carrying in your head: what a create puts on disk is
 * published the instant `git worktree add` returns, BEFORE the card resolves —
 * a close racing the create needs the path long before the rest of this
 * finishes (see [`created`]).
 */
import { locationOf, type PaneProvisioning } from "../../domain/deck";
import { describeError, log } from "../../ipc/log";
import { createWorktree, inspectRepo } from "../../ipc/worktree";
import type { ProvisionCallbacks } from "../provisioning";
import type { CreatedWorktree, WorktreeProvisioner } from "./index";
import type { InOrder } from "./queue";

export type WorktreeProvisioning = Pick<
  WorktreeProvisioner,
  "provision" | "awaitCreated" | "registerPostProvision" | "clearPostProvision"
>;

export function createWorktreeProvisioning(
  inOrder: InOrder,
  rollbackWorktree: (
    repo: string,
    rec: { path: string; branch: string },
  ) => Promise<void>,
): WorktreeProvisioning {
  /**
   * Post-provision steps, keyed by pane id: a JS step run AFTER a pane's
   * worktree is created but BEFORE its card resolves — the
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
   * a post-provision step runs on the pane's behalf, so waiting behind it races
   * the close — and letting the CREATE delete supplies the path but loses the
   * ordering, removing a directory a step is still writing into.
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

  /**
   * One pane's create → its card resolves or fails.
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
    workspaceName: string,
    cb: ProvisionCallbacks,
  ): Promise<void> {
    /**
     * The pane left while we were working. Asked after every await that could
     * outlive it, because everything past the create is done ON ITS BEHALF: a
     * post-provision step would run for a pane that is gone, and `onResolved`
     * would hand a worktree to a pane that cannot take it.
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
      // In the queue like every other worktree operation. A create was the one
      // that was not, and the close flow hands the freed folder straight back:
      // the "+ Agent" dialog suggests a path whose teardown may still be queued
      // (the pane has already left the deck, so nothing reads it as occupied),
      // and whoever ran first won. Queued, the teardown that was asked for first
      // finishes first, and the create either lands afterwards or fails honestly.
      rec = await inOrder(() =>
        createWorktree({
          repo: intent.repo,
          agentId: paneId,
          branch: intent.branch,
          // The intent's own picked base outranks the repo HEAD pinned below.
          base: intent.base ?? batchBase?.commit,
          ...(!intent.base && batchBase?.branch && { baseBranch: batchBase.branch }),
          workspace: workspaceName,
          index: intent.index,
          path: intent.path,
        }),
      );
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
    // Before the post-provision step, not only after: it runs on the pane's
    // behalf, and there is no behalf left once the pane is gone.
    if (abandoned()) return;

    // The worktree is on disk — run any registered post-provision step (a
    // journal fork's store surgery, bound to the CREATED worktree). A failure
    // rolls the worktree back and fails the card; the step stays registered, so
    // Retry re-runs it rather than resolving into a plain (non-fork) pane.
    const stepError = await runPostProvision(paneId, {
      cwd: rec.path,
      branch: rec.branch,
    });
    // The last gate, and it comes BEFORE the step's result is judged. A pane
    // closed mid-step is often WHY the step failed, and the failure branch
    // below would then roll back a worktree whose fate is the close's to
    // decide — the one thing this function must never do. Past this line the
    // pane owns the worktree and an ordinary close can name it by its `cwd`,
    // so the published entry stops being anyone's only handle on it.
    if (abandoned()) return;
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
    created.delete(paneId);

    cb.onResolved(paneId, { cwd: rec.path, branch: rec.branch });
  }

  return {
    async provision(panes, workspaceName, cb) {
      const pending = panes.flatMap((p) => {
        const location = locationOf(p);
        return location.kind === "provisioning" ? [{ id: p.id, card: location.card }] : [];
      });
      if (pending.length === 0) return;

      let batchBase: { commit?: string; branch?: string } | undefined;
      try {
        const inspected = await inspectRepo(pending[0].card.repo);
        batchBase = {
          ...(inspected.head && { commit: inspected.head }),
          ...(inspected.branch && { branch: inspected.branch }),
        };
      } catch {
        batchBase = undefined; // create resolves HEAD itself when base is omitted
      }

      await Promise.all(
        pending.map((p) => provisionPane(p.id, p.card, batchBase, workspaceName, cb)),
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
  };
}
