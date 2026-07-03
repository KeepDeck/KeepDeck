import type { AgentType } from "../domain/agents";
import {
  makePanes,
  makeProvisioningPanes,
  type Pane,
  type PaneProvisioning,
} from "../domain/panes";
import type { WorktreeTarget } from "../domain/workspaces";
import { describeError, log } from "../ipc/log";
import { createWorktree, inspectRepo, removeWorktree } from "../ipc/worktree";

/**
 * Optimistic provisioning: panes land in the deck the moment they're asked
 * for — in worktree mode as status cards carrying their create intent — and
 * `runProvisioning` performs the actual `git worktree add`s in the
 * background, reporting each result into the deck as it settles. Nothing
 * here awaits before the user sees their panes.
 */

/** Where the background runner reports as each pane's create settles. */
export interface ProvisionCallbacks {
  onResolved(paneId: string, worktree: { cwd: string; branch: string }): void;
  onFailed(paneId: string, error: string): void;
}

/** The runner's usual sinks: the deck's provisioning actions for `wsId`.
 * Both no-op inside the reducer when the pane was closed mid-create. */
export function provisionInto(
  deck: {
    resolvePaneProvisioning(
      wsId: string,
      paneId: string,
      worktree: { cwd: string; branch: string },
    ): void;
    setPaneProvisioningError(
      wsId: string,
      paneId: string,
      error: string | null,
    ): void;
  },
  wsId: string,
): ProvisionCallbacks {
  return {
    onResolved: (paneId, worktree) =>
      deck.resolvePaneProvisioning(wsId, paneId, worktree),
    onFailed: (paneId, error) =>
      deck.setPaneProvisioningError(wsId, paneId, error),
  };
}

/**
 * Build `count` panes for a workspace, synchronously. In worktree mode each
 * pane carries its create intent (a status card until `runProvisioning`
 * resolves it); otherwise plain panes that run in the workspace cwd.
 */
export function planPanes(
  ws: { cwd: string; worktreeBaseDir: string | null; name: string },
  startSeq: number,
  count: number,
  agentType: AgentType,
): Pane[] {
  if (!ws.worktreeBaseDir) return makePanes(startSeq, count, agentType);
  return makeProvisioningPanes(startSeq, count, agentType, {
    cwd: ws.cwd,
    baseDir: ws.worktreeBaseDir,
    name: ws.name,
  });
}

/**
 * Create the worktrees behind `panes`' provisioning cards, reporting each
 * result as it lands (completion order is whatever the per-repo lock hands
 * out — the deck shows panes coming alive as they're ready). One base commit
 * is pinned for the whole batch so concurrent creates don't straddle a moving
 * HEAD. Panes without an intent are ignored, so a retry can pass one pane and
 * the batch flows can pass them all. Never throws: a failure lands on its
 * pane's card via `onFailed`.
 */
export async function runProvisioning(
  panes: Pane[],
  cb: ProvisionCallbacks,
): Promise<void> {
  const pending = panes.filter((p) => p.provisioning);
  if (pending.length === 0) return;

  let base: string | undefined;
  try {
    base = (await inspectRepo(pending[0].provisioning!.repo)).head ?? undefined;
  } catch {
    base = undefined; // create resolves HEAD itself when base is omitted
  }

  await Promise.all(
    pending.map((p) => provisionPane(p.id, p.provisioning!, base, cb)),
  );
}

/** One pane's create → its card resolves or fails. */
async function provisionPane(
  paneId: string,
  intent: PaneProvisioning,
  base: string | undefined,
  cb: ProvisionCallbacks,
): Promise<void> {
  try {
    const rec = await createWorktree({
      repo: intent.repo,
      baseDir: intent.baseDir ?? "",
      agentId: paneId,
      branch: intent.branch,
      base,
      workspace: intent.workspace,
      index: intent.index,
      path: intent.path,
    });
    cb.onResolved(paneId, { cwd: rec.path, branch: rec.branch });
  } catch (e) {
    log.error(
      "web:provisioning",
      `worktree create failed for ${paneId}: ${describeError(e)}`,
    );
    cb.onFailed(paneId, describeError(e));
  }
}

/**
 * Tear down each target's git worktree and branch when the close dialog's delete
 * checkbox was ticked. Always forced — the checkbox is explicit intent, so a
 * dirty worktree / unmerged branch is discarded per the user's decision. Never
 * throws: a failing target is collected so one bad worktree doesn't strand the
 * rest, and the messages surface in the error dialog.
 */
export async function discardWorktrees(
  targets: WorktreeTarget[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const t of targets) {
    try {
      await removeWorktree(t.repo, t.path, { force: true, branch: t.branch });
    } catch (e) {
      log.warn("web:provisioning", `worktree discard failed for ${t.path}: ${describeError(e)}`);
      failures.push(`${t.branch}: ${e}`);
    }
  }
  return failures;
}
