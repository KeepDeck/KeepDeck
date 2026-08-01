/**
 * Tearing a worktree down: our own hooks out of the directory first, then
 * git.
 *
 * Every teardown goes through here — a close's removal and a half-prepared
 * create's rollback alike — because two paths doing it by hand is what let
 * an arming land inside a `git worktree remove`.
 */
import type { WorktreeTarget } from "../../domain/deck";
import { describeError, log } from "../../ipc/log";
import { removeWorktree } from "../../ipc/worktree";
import type { WorktreeProvisioner } from "./index";
import type { InOrder } from "./queue";

export type WorktreeTeardown = Pick<WorktreeProvisioner, "remove"> & {
  /** Best-effort teardown of a half-prepared worktree (a failed create's
   * rollback), so Retry re-creates cleanly. */
  rollback(repo: string, rec: { path: string; branch: string }): Promise<void>;
};

export function createWorktreeTeardown(
  inOrder: InOrder,
  disarm: (roots: string[]) => Promise<boolean>,
): WorktreeTeardown {
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
      await disarm([target.path]);
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

  return {
    rollback: rollbackWorktree,

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
