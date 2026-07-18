/**
 * Per-workspace staged-skills memo for the spawn path. Staging rebuilds the
 * on-disk views from the library, so it runs once per workspace and is
 * remembered — every later pane spawn in that workspace reuses the promise —
 * until a library edit invalidates the memo, or the workspace's WORKTREE SET
 * changes (a new worktree must be armed with its codex-facing symlink right
 * away, not after the next library edit). A `null` result (empty library, or
 * a failed staging degraded by the IPC layer) is remembered too: panes then
 * spawn without skills rather than re-hitting a broken backend.
 */
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import { stageSkills, type SkillsStagingViews } from "../ipc/skills";

const staged = new Map<string, Promise<SkillsStagingViews | null>>();

/** The workspace's staged views (memoized; concurrent callers share one
 * in-flight staging). `spawnRoots` = every pane spawn cwd of the workspace
 * — worktree roots and the plain workspace cwd alike (NOT only worktrees;
 * codex arming covers wherever a CLI actually starts). */
export function stagedSkillsFor(
  workspace: WorkspaceRef,
  spawnRoots: string[] = [],
): Promise<SkillsStagingViews | null> {
  const roots = [...new Set(spawnRoots)].sort();
  // The memo is keyed by the workspace INSTANCE — ids may be reused after a
  // close, instances never are, so a reborn id can't be served a dead
  // lifetime's promise (whose dirs the close's prune may have deleted). The
  // DISK key stays the durable id: the library the user edits lives under
  // it, and re-staging the same id rebuilds the same dirs correctly.
  // NUL-joined: the one byte no path or instance can contain.
  const key = [workspace.instance, ...roots].join("\u0000");
  let views = staged.get(key);
  if (!views) {
    views = stageSkills(workspace.id, roots);
    staged.set(key, views);
  }
  return views;
}

/** The library changed (any scope): every workspace re-stages on its next
 * spawn. Editing is rare and staging is cheap — no finer bookkeeping. */
export function invalidateSkillsStaging(): void {
  staged.clear();
}
