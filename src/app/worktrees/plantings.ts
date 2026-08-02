/**
 * Everything KeepDeck puts INSIDE a pane's working directory — the workspace's
 * staged shared skills, and the MCP client config a file-fed CLI reads — plus
 * the housekeeping that retires what no live workspace claims any more.
 *
 * One module for both, because they are the same operation with different
 * payloads: each ARMS a spawn root, each has to be undone when that root
 * leaves, and each is only safe under two conditions this owner is the only
 * place that can state — it runs in the manager's queue (an arming that landed
 * inside a worktree removal is the bug this whole owner exists to prevent), and
 * it is re-checked against the LIVE deck at the moment it runs, not at the
 * moment it was asked for. Planting from anywhere else means writing those two
 * conditions out a second time, and a second copy is how the skills path came
 * to have guards the MCP path did not.
 *
 * The memo below caches the RESULT of a call whose SIDE EFFECT was an arming,
 * which is why disarming always invalidates it.
 */
import {
  disarmSkills,
  pruneSkills,
  stageSkills,
  type SkillsStagingViews,
} from "../../ipc/skills";
import { mcpArm, mcpDisarm, mcpPrune } from "../../ipc/mcpArming";
import type {
  LiveWorkspace,
  McpPlanting,
  SkillsInvalidation,
  WorktreeDeckView,
  WorktreeHousekeeping,
  WorktreeProvisioner,
} from "./index";
import type { InOrder } from "./queue";

export type WorktreePlantings = Pick<WorktreeProvisioner, "skillsFor"> &
  McpPlanting &
  WorktreeHousekeeping &
  SkillsInvalidation & {
    /** Take our own hooks out of `roots` and forget the stagings that put
     * them there — the teardown's half of the arming contract. */
    disarm(roots: string[]): Promise<boolean>;
  };

export function createPlantings(
  deck: WorktreeDeckView,
  inOrder: InOrder,
): WorktreePlantings {
  /** In-flight and completed stagings, keyed by workspace instance + root set
   * (see [`WorktreeManager.skillsFor`]). A `null` result is remembered too. The
   * roots ride along because a teardown has to find the entries that stood for
   * the arming it just undid — see [`forgetStaged`]. */
  const staged = new Map<
    string,
    { roots: string[]; views: Promise<SkillsStagingViews | null> }
  >();

  /** The deck as the last sweep acted on it, and what the next one diffs against
   * to find the roots that left. `null` = no pass has completed, which is NOT the
   * same as "an empty deck": that first pass is the one that clears what a crash
   * left behind, so it must run even against nothing. Only a pass whose IPCs
   * actually got through records itself here — otherwise a transient failure
   * would be remembered as done and never retried. */
  let swept: LiveWorkspace[] | null = null;

  /** Which spawn cwds no live workspace claims any more — the one rule that
   * covers a closed pane, a closed workspace and a doomed worktree alike. */
  function unclaimed(candidates: string[], live: LiveWorkspace[]): string[] {
    const claimed = new Set(live.flatMap((ws) => ws.roots));
    return [...new Set(candidates)].filter((root) => !claimed.has(root));
  }

  /** Drop every memoized staging whose root set covers one of `roots`.
   *
   * The memo caches the RESULT of a call whose SIDE EFFECT was arming those
   * directories, so disarming one has to invalidate it. Without this, a root
   * that leaves and comes back — the default when a pane is deleted and a new
   * one takes the freed folder — is served a cache hit, `stageSkills` never
   * runs again, and the new worktree silently has no `.agents/skills`. */
  function forgetStaged(roots: string[]): void {
    if (roots.length === 0) return;
    const dropped = new Set(roots);
    for (const [key, entry] of staged) {
      if (entry.roots.some((root) => dropped.has(root))) staged.delete(key);
    }
  }

  /** What the live set looks like, for "has anything I act on changed?".
   * Deliberately here and nowhere else: a second projection of the same
   * question, in a React hook, is how the trigger and the answer came to
   * disagree. */
  function liveFingerprint(live: LiveWorkspace[]): string {
    return JSON.stringify(
      live.map((ws) => [ws.id, [...ws.roots].sort()]).sort(),
    );
  }

  /** Take our own hooks out of `roots` — the ones no live workspace still claims
   * — and forget the stagings that put them there.
   *
   * The two steps are one step: the memo caches the RESULT of a call whose SIDE
   * EFFECT was the arming, so a disarm that left the memo alone would serve a
   * cache hit for a directory whose symlink is gone. Stated once, because a
   * teardown and the sweep both need it and spelling it twice let them drift
   * (one filtered its disarm and not its forget). */
  async function disarm(roots: string[]): Promise<boolean> {
    // BOTH plantings, always together: skills and the MCP config are put in
    // the same directories by the same owner, and a teardown that took only
    // one back would leave the other pointing into a deleted worktree.
    const departed = unclaimed(roots, deck.live());
    const results = await Promise.all([
      disarmSkills(departed),
      mcpDisarm(departed),
    ]);
    const ok = results.every(Boolean);
    forgetStaged(roots);
    return ok;
  }

  return {
    disarm,

    plantMcp(workspaceId, root, content) {
      // Queued, and that is the WHOLE guard: a write that started while a
      // teardown is in flight would land inside git's recursive delete.
      //
      // Deliberately NOT re-checked against the live deck, unlike `skillsFor`
      // below. That check exists there because staging arms a SET of roots
      // snapshotted at call time, so by execution time some may have left and
      // the set has to be narrowed. Here there is one root and it is the
      // asking pane's own cwd — nothing to narrow. Re-checking it instead
      // refused every pane the deck cannot see YET: a manual resume, a fork
      // into a directory, a fork into a fresh worktree all plant before the
      // pane lands, and each silently got no servers. The case the check was
      // meant to catch — the directory went away while we queued — is refused
      // by the backend, which reports a cwd that is no longer a directory.
      return inOrder(() => mcpArm(workspaceId, [{ root, content }]));
    },

    retractMcp(roots) {
      // NOT filtered by `unclaimed`, unlike a teardown's disarm: this is the
      // transport going down, and the configs to take back are exactly the
      // LIVE ones — they name a socket that no longer exists.
      return inOrder(() => mcpDisarm(roots));
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

    sweep(deckHydrated) {
      if (!deckHydrated) return Promise.resolve();
      return inOrder(async () => {
        // Compared HERE, not at the call, and that is the whole coalescing
        // mechanism: a burst of transitions queues a burst of passes, and every
        // pass after the first finds the live set already accounted for and costs
        // no IPC. Reading it at the call instead would compare against a `swept`
        // a queued pass was about to overwrite — which is what a second
        // "sweep again" flag then had to paper over.
        const live = deck.live();
        if (swept && liveFingerprint(swept) === liveFingerprint(live)) return;
        const departed = unclaimed(
          swept?.flatMap((ws) => ws.roots) ?? [],
          live,
        );
        const disarmed = await disarm(departed);
        // Re-read for the PRUNE: the list that decides what to DELETE must not be
        // one IPC round trip old, or a workspace created while the disarm was in
        // flight is pruned as dead and its panes spawn pointing at deleted dirs.
        const liveIds = deck.live().map((ws) => ws.id).sort();
        const sweeps = await Promise.all([
          pruneSkills(liveIds),
          mcpPrune(liveIds),
        ]);
        const pruned = sweeps.every(Boolean);
        // Only a pass that got through counts as done. Recording a failed one
        // would retire the very state it failed to clean until the deck happens
        // to change again — and at boot that state is a crash's leftovers.
        if (disarmed && pruned) swept = live;
      });
    },
  };
}
