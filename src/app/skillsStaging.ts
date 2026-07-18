/**
 * Per-workspace staged-skills memo for the spawn path. Staging rebuilds the
 * on-disk views from the library, so it runs once per workspace and is
 * remembered — every later pane spawn in that workspace reuses the promise —
 * until a library edit invalidates the memo. A `null` result (empty library,
 * or a failed staging degraded by the IPC layer) is remembered too: panes
 * then spawn without skills rather than re-hitting a broken backend.
 */
import { stageSkills, type SkillsStagingViews } from "../ipc/skills";

const staged = new Map<string, Promise<SkillsStagingViews | null>>();

/** The workspace's staged views (memoized; concurrent callers share one
 * in-flight staging). */
export function stagedSkillsFor(wsId: string): Promise<SkillsStagingViews | null> {
  let views = staged.get(wsId);
  if (!views) {
    views = stageSkills(wsId);
    staged.set(wsId, views);
  }
  return views;
}

/** The library changed (any scope): every workspace re-stages on its next
 * spawn. Editing is rare and staging is cheap — no finer bookkeeping. */
export function invalidateSkillsStaging(): void {
  staged.clear();
}
