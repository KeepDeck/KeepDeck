/**
 * The skills feature's worktree adapter: it turns the manager's ordering port
 * and live-deck port into staged views. Construction belongs to the runtime
 * composition root; the infrastructure manager only receives the resulting
 * composite planting.
 *
 * It stages and nothing more: what an agent needs planted in a pane's cwd to
 * find the staged skills is that agent's plugin's to declare (`arm.plan`),
 * and the cwd arming engine's to plant.
 */
import { fetchSkills, stageSkills, type ExcludedSkill } from "../../ipc/skills";
import { log } from "../../ipc/log";
import { errorMessage } from "@keepdeck/plugin-api";
import { skillsUnfitForAgents } from "../../domain/skills";
import type {
  WorktreeDeckView,
  WorktreeSkillViews,
  WorktreeSkillsPlanting,
} from "../worktrees";
import type { InOrder } from "../worktrees/queue";

export type SkillsStaging = WorktreeSkillsPlanting;

/** The library rows no agent may be handed, by the codec's judgement — or
 * null when the library could not be read: then nothing stages (a pane
 * spawns fine without skills), rather than staging rows nobody judged. */
async function unfitSkills(): Promise<ExcludedSkill[] | null> {
  try {
    return skillsUnfitForAgents(await fetchSkills()).map(({ scope, wsId, name }) => ({ scope, wsId, name }));
  } catch (e) {
    log.warn("web:skills", `skills_list failed; spawning without skills: ${errorMessage(e)}`);
    return null;
  }
}

export function createSkillsStaging(deck: WorktreeDeckView, inOrder: InOrder): SkillsStaging {
  const staged = new Map<
    string,
    { roots: string[]; views: Promise<WorktreeSkillViews | null> }
  >();

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
      if (memoized) return memoized.views;

      // The staging below names this entry (a narrowed set is memoized under
      // its own key), so the entry exists first; its `views` is replaced
      // before this function returns, so nobody reads the placeholder.
      const entry: {
        roots: string[];
        views: Promise<WorktreeSkillViews | null>;
      } = { roots, views: Promise.resolve(null) };
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
        return unfitSkills().then((excluded) =>
          excluded === null ? null : stageSkills(workspace.id, armable, excluded),
        );
      });
      staged.set(key, entry);
      return entry.views;
    },

    invalidateSkills() {
      staged.clear();
    },
  };
}
