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
import { stageSkills, type SkillsStagingViews } from "../ipc/skills";

const staged = new Map<string, Promise<SkillsStagingViews | null>>();

/** The workspace's staged views (memoized; concurrent callers share one
 * in-flight staging). `worktreeRoots` = the workspace's worktree pane roots. */
export function stagedSkillsFor(
  wsId: string,
  worktreeRoots: string[] = [],
): Promise<SkillsStagingViews | null> {
  const roots = [...new Set(worktreeRoots)].sort();
  const key = [wsId, ...roots].join("\n");
  let views = staged.get(key);
  if (!views) {
    views = stageSkills(wsId, roots);
    staged.set(key, views);
  }
  return views;
}

/** The library changed (any scope): every workspace re-stages on its next
 * spawn. Editing is rare and staging is cheap — no finer bookkeeping. */
export function invalidateSkillsStaging(): void {
  staged.clear();
}
