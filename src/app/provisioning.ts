import type { AgentType } from "../domain/agents";
import { clampPaneCount } from "../domain/layout";
import { makePanes, paneId, type Pane } from "../domain/panes";
import type { WorktreeTarget } from "../domain/workspaces";
import { describeError, log } from "../ipc/log";
import { createWorktree, inspectRepo, removeWorktree } from "../ipc/worktree";

/**
 * Build `count` panes for a workspace. In worktree mode each agent gets its own
 * git worktree, all pinned to one base commit (resolved once) so a concurrent
 * batch starts from the same state; otherwise plain panes that run in the cwd.
 * A per-agent create failure falls back to a cwd pane so the batch still lands.
 */
export async function provisionPanes(
  ws: { cwd: string; worktreeBaseDir: string | null; name: string },
  startSeq: number,
  count: number,
  agentType: AgentType,
  onError: (message: string) => void,
): Promise<Pane[]> {
  if (!ws.worktreeBaseDir) return makePanes(startSeq, count, agentType);

  let base: string | undefined;
  try {
    base = (await inspectRepo(ws.cwd)).head ?? undefined;
  } catch {
    base = undefined; // create resolves HEAD itself when base is omitted
  }

  const n = clampPaneCount(count);
  const panes: Pane[] = [];
  for (let i = 0; i < n; i++) {
    const agentId = paneId(startSeq + i);
    try {
      const rec = await createWorktree({
        repo: ws.cwd,
        baseDir: ws.worktreeBaseDir,
        agentId,
        base,
        workspace: ws.name,
        index: i + 1,
      });
      panes.push({ id: agentId, cwd: rec.path, branch: rec.branch, agentType });
    } catch (e) {
      log.error("web:provisioning", `worktree create failed for ${agentId}: ${describeError(e)}`);
      onError(`Failed to create worktree for ${agentId}:\n${e}`);
      panes.push({ id: agentId, agentType }); // fall back to the workspace cwd
    }
  }
  return panes;
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
