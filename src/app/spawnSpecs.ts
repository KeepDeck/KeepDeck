import type { AgentInfo } from "../domain/agents";
import type { Pane } from "../domain/panes";
import {
  buildRunPlan,
  buildSpawnPlan,
  type SpawnPlan,
  type SpawnPlanContext,
} from "../domain/spawnPlans";

/**
 * One spawn plan per pane id, stable across re-renders — module scope like
 * the id mints. Stability matters: a claude plan MINTS a session id, and
 * minting again on a later render would hand the terminal a different id
 * than the one recorded. Pane ids are app-unique, so entries are never
 * reused; closed panes leave a few bytes behind, which is fine.
 */
const specs = new Map<string, SpawnPlan>();

/** Pre-register a revive plan (resume) before the pane wakes — takes
 * precedence over the fresh plan the render pass would build. */
export function setPaneSpawnSpec(paneId: string, spec: SpawnPlan): void {
  specs.set(paneId, spec);
}

/** The pane's spawn plan — cached, or built fresh on first use. Called during
 * render, so it must stay side-effect-free apart from the cache itself.
 * `cwd` is the pane's resolved working directory (its worktree, else the
 * workspace folder) — a run pane's env contract is built from it. The launch
 * and run-again flows pre-register a run plan carrying the allocated port;
 * this fallback builds one without it (documented on [`buildRunPlan`]). */
export function paneSpawnSpec(
  pane: Pane,
  ctx: SpawnPlanContext,
  agents: AgentInfo[],
  cwd: string,
): SpawnPlan {
  const cached = specs.get(pane.id);
  if (cached) return cached;
  const spec = pane.run
    ? buildRunPlan(pane.run.command, { worktree: cwd, branch: pane.branch })
    : buildSpawnPlan(pane.agentType ?? "claude", pane.id, ctx, { agents });
  specs.set(pane.id, spec);
  return spec;
}

/** The cached plan, if any (no building) — for the binding effect. */
export function peekPaneSpawnSpec(paneId: string): SpawnPlan | undefined {
  return specs.get(paneId);
}

/** Test isolation. */
export function resetPaneSpawnSpecs(): void {
  specs.clear();
}
