/**
 * The skills feature's worktree adapter: it turns the manager's ordering port
 * and live-deck port into staged views. Construction belongs to the runtime
 * composition root; the infrastructure manager only receives the resulting
 * composite planting.
 */
import { armSkills, type SkillArmRefusal } from "../../ipc/skills";
import { stageSkills } from "../../ipc/skills";
import type {
  WorktreeDeckView,
  WorktreeSkillViews,
  WorktreeSkillsPlanting,
} from "../worktrees";
import type { InOrder } from "../worktrees/queue";

export type SkillsStaging = WorktreeSkillsPlanting;

export function createSkillsStaging(
  deck: WorktreeDeckView,
  inOrder: InOrder,
  /** Where an arming pass reports what the user's own files kept it out
   * of. Optional: non-app tests need not listen. */
  onRefusals: (refusals: SkillArmRefusal[]) => void = () => {},
): SkillsStaging {
  const staged = new Map<
    string,
    { roots: string[]; views: Promise<WorktreeSkillViews | null> }
  >();

  /** Views from the memo, arming from scratch.
   *
   * THE SPLIT that makes a refusal honest: staging is expensive and
   * cached, arming is four syscalls per cwd and is not. Folded together,
   * the user moved their `.agents` file away and kept being told about it
   * until something unrelated cleared the cache. Asked every time, the
   * answer cannot be stale.
   */
  const armThen = (
    wsId: string,
    entry: { roots: string[]; views: Promise<WorktreeSkillViews | null> },
  ): Promise<WorktreeSkillViews | null> =>
    entry.views.then(async (views) => {
      // Nothing staged, nothing to arm — and no refusal to report: the
      // user has done nothing, there is simply no view.
      if (!views) return views;
      const report = await inOrder(() => armSkills(wsId, entry.roots));
      onRefusals(report.refused);
      return views;
    });

  return {
    forgetStaged(roots) {
      if (roots.length === 0) return;
      const dropped = new Set(roots);
      for (const [key, entry] of staged) {
        if (entry.roots.some((root) => dropped.has(root))) staged.delete(key);
      }
    },

    skillsFor(workspace, landing) {
      const keyFor = (roots: string[]) =>
        JSON.stringify([workspace.instance, ...roots]);
      const roots = [
        ...new Set([...deck.rootsOf(workspace), ...(landing ? [landing] : [])]),
      ].sort();
      const key = keyFor(roots);
      const memoized = staged.get(key);
      if (memoized) return armThen(workspace.id, memoized);

      const entry: {
        roots: string[];
        views: Promise<WorktreeSkillViews | null>;
      } = { roots, views: undefined as never };
      entry.views = inOrder(() => {
        const claimed = new Set(deck.rootsOf(workspace));
        const armable = roots.filter(
          (root) => claimed.has(root) || root === landing,
        );
        if (armable.length !== roots.length) {
          staged.delete(key);
          entry.roots = armable;
          staged.set(keyFor(armable), entry);
        }
        if (armable.length === 0 && !deck.live().some((ws) => ws.id === workspace.id)) {
          return Promise.resolve(null);
        }
        return stageSkills(workspace.id, armable);
      });
      staged.set(key, entry);
      return armThen(workspace.id, entry);
    },

    invalidateSkills() {
      staged.clear();
    },
  };
}
