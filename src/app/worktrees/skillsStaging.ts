/**
 * The workspace's staged shared skills, and the memo that keeps a spawn from
 * rebuilding them per pane.
 *
 * Staging ARMS directories (a `.agents/skills` symlink in every live spawn
 * root), so every call runs in the owner's queue: an arming that landed inside
 * a worktree removal is the bug that owner exists to prevent. The memo caches
 * the RESULT of a call whose SIDE EFFECT was that arming, which is why
 * disarming always has to invalidate it — see [`forgetStaged`].
 */
import { stageSkills, type SkillsStagingViews } from "../../ipc/skills";
import type { SkillsInvalidation, WorktreeDeckView, WorktreeProvisioner } from "./index";
import type { InOrder } from "./queue";

export type SkillsStaging = Pick<WorktreeProvisioner, "skillsFor"> &
  SkillsInvalidation & {
    /** Forget the stagings that armed any of `roots` — the other half of a
     * disarm, and never separable from it. */
    forgetStaged(roots: string[]): void;
  };

export function createSkillsStaging(
  deck: WorktreeDeckView,
  inOrder: InOrder,
): SkillsStaging {
  /** In-flight and completed stagings, keyed by workspace instance + root set
   * (see [`WorktreeManager.skillsFor`]). A `null` result is remembered too. The
   * roots ride along because a teardown has to find the entries that stood for
   * the arming it just undid — see [`forgetStaged`]. */
  const staged = new Map<
    string,
    { roots: string[]; views: Promise<SkillsStagingViews | null> }
  >();

  return {
    /** Drop every memoized staging whose root set covers one of `roots`.
     *
     * Without this, a root that leaves and comes back — the default when a pane
     * is deleted and a new one takes the freed folder — is served a cache hit,
     * `stageSkills` never runs again, and the new worktree silently has no
     * `.agents/skills`. */
    forgetStaged(roots) {
      if (roots.length === 0) return;
      const dropped = new Set(roots);
      for (const [key, entry] of staged) {
        if (entry.roots.some((root) => dropped.has(root))) staged.delete(key);
      }
    },

    skillsFor(workspace, landing) {
      const keyFor = (roots: string[]) =>
        // A JSON array as the memo key: injective for any path, with no reliance
        // on a separator byte that paths are merely assumed not to contain.
        JSON.stringify([workspace.instance, ...roots]);
      const roots = [
        ...new Set([...deck.rootsOf(workspace), ...(landing ? [landing] : [])]),
      ].sort();
      const key = keyFor(roots);
      const memoized = staged.get(key);
      if (memoized) return memoized.views;

      const entry: {
        roots: string[];
        views: Promise<SkillsStagingViews | null>;
      } = { roots, views: undefined as never };
      // Queued: a staging that started while a teardown is in flight would arm
      // the very directory being deleted (see [`queue`]).
      entry.views = inOrder(() => {
        // Re-checked at EXECUTION time. A root can only have left while this
        // waited — the teardown that removed it ran in this same queue — and
        // arming a directory that is gone is the mistake this owner exists to
        // prevent. The `landing` cwd is exempt: the deck cannot see a pane that
        // has not landed yet.
        const claimed = new Set(deck.rootsOf(workspace));
        const armable = roots.filter(
          (root) => claimed.has(root) || root === landing,
        );
        if (armable.length !== roots.length) {
          // The entry may only ever claim what it ARMED. Left keyed on the wider
          // set, it would answer a later call whose roots are back to that set —
          // a cache hit for directories this staging deliberately skipped, which
          // would then never be armed by anyone.
          staged.delete(key);
          entry.roots = armable;
          staged.set(keyFor(armable), entry);
        }
        // Nothing to stage for a workspace that is gone: `stage` would rebuild
        // its derived dirs from the library, which the sweep is on its way to
        // delete. A landing cwd is the exception — it belongs to a pane that has
        // not landed yet, and its workspace is live by construction.
        if (armable.length === 0 && !deck.live().some((ws) => ws.id === workspace.id)) {
          return Promise.resolve(null);
        }
        return stageSkills(workspace.id, armable);
      });
      staged.set(key, entry);
      return entry.views;
    },

    invalidateSkills() {
      staged.clear();
    },
  };
}
