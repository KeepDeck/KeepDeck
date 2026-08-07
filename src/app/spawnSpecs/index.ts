/**
 * Spawn plans: what a pane will actually run.
 *
 * This door owns the three ways a plan is asked for — a live pane, a resume,
 * a fork — and delegates the two halves they share: [`./plan`] builds one
 * through the agent's hook, [`./cache`] remembers it per pane.
 */
import type { ResumeOrigin } from "../../domain/agents";
import type { SpawnPlan, SpawnPlanContext } from "./plans";
import {
  paneAgentType,
  paneHasProcess,
  type Pane,
  type Workspace,
} from "../../domain/deck";
import { describeError, log } from "../../ipc/log";
import {
  contributionSupportsFork,
  contributionSupportsResume,
} from "../../plugins/agents/implementation";
import type { PluginManager } from "../pluginManager";
import {
  buildAndCache,
  hasPaneSpawnSpec,
  isPaneSpawnSpecPending,
  peekPanePlanError,
} from "./cache";
import { buildPlan, findAgent, type PaneSpawnFacts } from "./plan";

export * from "./plans";
// Named, not a star: `resetPaneSpawnSpecs` is a test-only API (the cache is
// module-global state, which is the actual defect) and a star put it on the
// FEATURE's door, where every consumer could reach it. Tests import it from
// `./cache` directly, so the eventual removal touches one file.
export {
  bindPaneSpawnSpecSession,
  buildAndCache,
  clearPanePlanError,
  dropPaneSpawnSpec,
  hasPaneSpawnSpec,
  isPaneSpawnSpecPending,
  markPaneResumeOrigin,
  paneIdByMcpToken,
  peekPanePlanError,
  peekPaneSpawnSpec,
  subscribeSpawnSpecs,
} from "./cache";
export type { PaneSpawnFacts } from "./plan";

export type SpawnPluginAccess = Pick<
  PluginManager,
  "pluginHost" | "pluginRegistries"
>;


/** Build and cache an exclusive RESUME plan for an idle pane about to wake
 * or an exited pane the user explicitly restarts. Replaces any cached plan;
 * the generation reservation prevents the ordinary fresh sweep from racing. */
export async function buildResumeSpec(
  plugins: SpawnPluginAccess,
  agentType: string,
  facts: PaneSpawnFacts,
  ctx: SpawnPlanContext,
  resumeId: string,
  origin: ResumeOrigin,
): Promise<boolean> {
  const agent = findAgent(plugins, agentType);
  if (!agent) return false; // unavailable — the card keeps the pane idle
  if (!contributionSupportsResume(agent.entry)) {
    log.warn(
      "web:agents",
      `${agentType}: cannot resume ${facts.paneId} — plugin has no resume.plan hook`,
    );
    return false;
  }
  return buildAndCache(facts.paneId, () =>
    buildPlan(plugins, agent, facts, ctx, {
      kind: "resume",
      sessionId: resumeId,
      origin,
    }),
  );
}

/** Build and cache a FORK plan for a pane about to be minted: the agent's
 * `fork.plan` performs its store surgery, then fills how the forked session
 * spawns. The fork's own (new) session id is reported by the spawned CLI's
 * reporter like any fresh spawn. The source id remains as `forkOf` so the
 * host can baseline the cloned transcript once the new id is bound. */
export async function buildForkSpec(
  plugins: SpawnPluginAccess,
  agentType: string,
  facts: PaneSpawnFacts,
  ctx: SpawnPlanContext,
  fork: { sessionId: string; sourceCwd: string; transcriptPath?: string },
): Promise<boolean> {
  const agent = findAgent(plugins, agentType);
  if (!agent) return false;
  if (!contributionSupportsFork(agent.entry)) {
    log.warn(
      "web:agents",
      `${agentType}: cannot fork ${fork.sessionId} — plugin has no fork.plan hook`,
    );
    return false;
  }
  // A throwing hook PROPAGATES (mirroring resume): the recipes throw
  // precise, fail-loud diagnostics for store-layout drift, and muting them
  // into a boolean left the caller a generic message and a double log line.
  return buildAndCache(facts.paneId, () =>
    buildPlan(plugins, agent, facts, ctx, { kind: "fork", ...fork }),
  );
}

/**
 * Build and cache the ordinary spawn plan for ONE pane, if it still needs one.
 * Resolves to whether the cache changed, so a caller that publishes a snapshot
 * knows when to republish — a FAILED build counts, or the error tile never
 * renders and the pane hangs on "Waking up…" until some unrelated change.
 *
 * Which panes qualify is decided here, once: a dormant one gets its plan at
 * wake time instead (an exclusive resume plan, not this), a provisioning one
 * has no working directory yet — building would plan a spawn into the
 * workspace cwd, exactly the fallback the provisioning cards replaced — and an
 * agent no plugin provides is blocked by its own card. A pane already holding
 * a plan, mid-build, or with a failed build is left alone: the reservation is
 * what keeps a StrictMode re-run, or a sweep racing a manual resume, from
 * building twice.
 *
 * Separated from the sweep because the two answer different questions — what
 * this pane needs, and when to look — and only the second one belongs to
 * whoever is driving.
 */
export async function buildLivePaneSpec(
  plugins: SpawnPluginAccess,
  ws: Workspace,
  pane: Pane,
  ctx: SpawnPlanContext,
  asks: Pick<PaneSpawnFacts, "stagedSkills" | "mcpAccess">,
): Promise<boolean> {
  if (!paneHasProcess(pane)) return false;
  if (hasPaneSpawnSpec(pane.id) || isPaneSpawnSpecPending(pane.id) || peekPanePlanError(pane.id)) {
    return false;
  }
  const agent = findAgent(plugins, paneAgentType(pane));
  if (!agent) return false;
  try {
    return await buildAndCache(pane.id, () =>
      buildPlan(
        plugins,
        agent,
        {
          paneId: pane.id,
          workspace: { id: ws.id, instance: ws.instance },
          cwd: pane.cwd ?? ws.cwd,
          branch: pane.branch,
          yolo: pane.yolo,
          ...asks,
          ...(pane.remoteEndpoint
            ? {
                target: {
                  kind: "nativeServer" as const,
                  endpoint: pane.remoteEndpoint,
                },
              }
            : {}),
        },
        ctx,
      ),
    );
  } catch (error) {
    log.error(
      "web:agents",
      `${pane.id} plan build failed: ${describeError(error)}`,
    );
    // `buildAndCache` recorded the pane in `failed`; the cache DID change.
    return true;
  }
}


/** Whether this exact provider session began with inherited counters. */
export function spawnPlanNeedsUsageBaseline(
  spec: Pick<SpawnPlan, "resumeOf" | "forkSessionId"> | undefined,
  sessionId: string,
): boolean {
  return spec?.resumeOf === sessionId || spec?.forkSessionId === sessionId;
}

/**
 * Whether the plan CONTINUES something rather than starting clean — asked
 * without naming a session, because the id it inherits is not always known
 * yet. A fork carries `forkOf` (the SOURCE id) from the moment it is built
 * and gains `forkSessionId` only when the binding lands, so between those
 * two a report already carries the new id while the pair above cannot match
 * it. Reading "no match" as "started clean" there told the ledger a cloned
 * transcript was brand-new usage. Anything that inherits is uncertain until
 * the match succeeds, and uncertain is the safe half of the fence.
 */
export function spawnPlanInheritsSession(
  spec:
    | Pick<SpawnPlan, "resumeOf" | "forkOf" | "forkSessionId">
    | undefined,
): boolean {
  return Boolean(spec?.resumeOf ?? spec?.forkOf ?? spec?.forkSessionId);
}
