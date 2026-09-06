/**
 * Creating the worktrees behind provisioning cards, and publishing what
 * landed.
 *
 * Keyed by OWNER, not by pane: whatever asked for the directory — the team
 * whose card it is — is what the result, the early publish and any
 * post-provision step are filed under. The manager does not know what an
 * owner is; it knows an id and an intent.
 *
 * The one subtlety worth carrying in your head: what a create puts on disk is
 * published the instant `git worktree add` returns, BEFORE the card resolves —
 * a close racing the create needs the path long before the rest of this
 * finishes (see [`created`]). And the TICKET for that publish is taken out
 * synchronously, before the first await: a close confirmed in the window
 * between "asked" and "git ran" used to find nothing to wait for, delete the
 * owner, and leave the directory the create then made as an orphan.
 */
import type { WorktreeIntent } from "../../domain/deck";
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
   * Post-provision steps, keyed by owner id: a JS step run AFTER an owner's
   * worktree is created but BEFORE its card resolves — the
   * seam where a journal fork runs its store surgery bound to the CREATED
   * worktree. It runs on the initial create AND on every Retry (both go through
   * `provisionOwner`), so a retried fork re-runs its surgery instead of silently
   * resolving into a plain (non-fork) card. A step THROWS to fail (the worktree
   * is rolled back and the card fails); it is consumed once it succeeds, and
   * kept across a failed attempt so the retry re-runs it.
   *
   * PERSISTENCE COUPLING (don't miss this): a step lives ONLY in this in-memory
   * map — it cannot survive an app restart. So ANY owner that registers a step
   * MUST also be excluded from persistence, or its card restores as a plain
   * retryable card and Retry resolves a NON-fork card. The journal fork does
   * this via the location's `fork` marker, which `serializeDeck` drops; a future
   * second user of this map must add the equivalent.
   */
  const postProvisionSteps = new Map<
    string,
    (worktree: { cwd: string; branch: string }) => Promise<void>
  >();

  /**
   * What each owner's worktree create has put on disk, published the moment
   * `git worktree add` returns and BEFORE anything else the create does.
   *
   * Published early on purpose. The close needs two things a create cannot give
   * it at the same moment: the path, and permission to delete only after the
   * owner's processes are reaped. Waiting for the whole create supplies neither
   * — a post-provision step runs on the owner's behalf, so waiting behind it
   * races the close — and letting the CREATE delete supplies the path but loses
   * the ordering, removing a directory a step is still writing into.
   *
   * Publishing at the git call splits those apart: this promise always settles
   * promptly (nothing but the git call is in front of it), so the close can
   * await it, then reap, then delete — in that order, with `remove` doing the
   * removal and reporting its failures like any other.
   *
   * The entry — the TICKET — is taken out in `provision` itself, before its
   * first await, so a close confirmed while the repo is still being inspected
   * finds something to wait for. Kept until READ, then dropped. The owner also
   * drops its own entry once it takes ownership (`onResolved`), because from
   * then on it has a `cwd` and the close can name the worktree without help.
   */
  const created = new Map<string, Promise<CreatedWorktree | null>>();

  /** Run the registered step, if any. Returns null on success (or when none is
   * registered — a plain owner) and the failure message otherwise; a successful
   * step is consumed, a failed one is KEPT so a Retry re-runs it. */
  async function runPostProvision(
    ownerId: string,
    worktree: { cwd: string; branch: string },
  ): Promise<string | null> {
    const step = postProvisionSteps.get(ownerId);
    if (!step) return null;
    try {
      await step(worktree);
      postProvisionSteps.delete(ownerId);
      return null;
    } catch (e) {
      return describeError(e);
    }
  }

  /**
   * One owner's create → its card resolves or fails.
   *
   * What it puts on disk is published the instant `git worktree add` returns
   * (see [`created`]) through `publish`, the ticket `provision` took out for it.
   * Nothing here deletes on a close's behalf: this function only stops early,
   * and the close does the removing in the order it needs.
   */
  async function provisionOwner(
    ownerId: string,
    intent: WorktreeIntent,
    publish: (made: CreatedWorktree | null) => void,
    batchBase: { commit?: string; branch?: string } | undefined,
    workspaceName: string,
    cb: ProvisionCallbacks,
  ): Promise<void> {
    /**
     * The owner left while we were working. Asked after every await that could
     * outlive it, because everything past the create is done ON ITS BEHALF: a
     * post-provision step would run for an owner that is gone, and `onResolved`
     * would hand a worktree to one that cannot take it.
     * Whether that worktree then goes is the close's decision, not ours — it is
     * the only party that knows what the user ticked and when the process died.
     */
    const abandoned = (): boolean => {
      if (!cb.abandoned(ownerId)) return false;
      log.info(
        "web:worktrees",
        `${ownerId} left while its worktree was being created — stopping here`,
      );
      return true;
    };

    let rec: { path: string; branch: string };
    try {
      // In the queue like every other worktree operation. A create was the one
      // that was not, and the close flow hands the freed folder straight back:
      // the "+ Agent" dialog suggests a path whose teardown may still be queued
      // (the owner has already left the deck, so nothing reads it as occupied),
      // and whoever ran first won. Queued, the teardown that was asked for first
      // finishes first, and the create either lands afterwards or fails honestly.
      rec = await inOrder(() =>
        createWorktree({
          repo: intent.repo,
          ownerId,
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
        `worktree create failed for ${ownerId}: ${describeError(e)}`,
      );
      // Nothing landed, so a close has nothing to remove.
      publish(null);
      created.delete(ownerId);
      cb.onFailed(ownerId, describeError(e));
      return;
    }
    // The directory exists: say so before anything else can delay it. A close
    // racing this is the case the early publish is for.
    publish({ repo: intent.repo, path: rec.path, branch: rec.branch });
    // Before the post-provision step, not only after: it runs on the owner's
    // behalf, and there is no behalf left once the owner is gone.
    if (abandoned()) return;

    // The worktree is on disk — run any registered post-provision step (a
    // journal fork's store surgery, bound to the CREATED worktree). A failure
    // rolls the worktree back and fails the card; the step stays registered, so
    // Retry re-runs it rather than resolving into a plain (non-fork) card.
    const stepError = await runPostProvision(ownerId, {
      cwd: rec.path,
      branch: rec.branch,
    });
    // The last gate, and it comes BEFORE the step's result is judged. An owner
    // closed mid-step is often WHY the step failed, and the failure branch
    // below would then roll back a worktree whose fate is the close's to
    // decide — the one thing this function must never do. Past this line the
    // owner holds the worktree and an ordinary close can name it by its `cwd`,
    // so the published entry stops being anyone's only handle on it.
    if (abandoned()) return;
    if (stepError !== null) {
      log.error(
        "web:worktrees",
        `post-provision step failed for ${ownerId} in ${rec.path}: ${stepError}`,
      );
      await rollbackWorktree(intent.repo, rec);
      created.delete(ownerId);
      cb.onFailed(ownerId, stepError);
      return;
    }
    created.delete(ownerId);

    cb.onResolved(ownerId, { cwd: rec.path, branch: rec.branch });
  }

  return {
    async provision(requests, workspaceName, cb) {
      if (requests.length === 0) return;
      // The tickets, before anything is awaited: from this line a close that
      // asks `awaitCreated` for any of these owners waits for the git call
      // instead of finding nothing and deleting under it.
      const tickets = requests.map((request) => {
        let publish!: (made: CreatedWorktree | null) => void;
        created.set(
          request.ownerId,
          new Promise<CreatedWorktree | null>((resolve) => {
            publish = resolve;
          }),
        );
        return { request, publish };
      });

      let batchBase: { commit?: string; branch?: string } | undefined;
      try {
        const inspected = await inspectRepo(requests[0].intent.repo);
        batchBase = {
          ...(inspected.head && { commit: inspected.head }),
          ...(inspected.branch && { branch: inspected.branch }),
        };
      } catch {
        batchBase = undefined; // create resolves HEAD itself when base is omitted
      }

      await Promise.all(
        tickets.map(({ request, publish }) =>
          provisionOwner(request.ownerId, request.intent, publish, batchBase, workspaceName, cb),
        ),
      );
    },

    awaitCreated(ownerId) {
      const pending = created.get(ownerId);
      if (!pending) return Promise.resolve(null);
      created.delete(ownerId);
      return pending;
    },

    registerPostProvision(ownerId, step) {
      postProvisionSteps.set(ownerId, step);
    },

    clearPostProvision(ownerId) {
      postProvisionSteps.delete(ownerId);
    },
  };
}
