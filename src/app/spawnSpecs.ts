import { useEffect, useMemo, useState } from "react";
import type {
  AgentContribution,
  ForkPlanInput,
  SpawnPlanInput,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import {
  BRIDGE_PROTOCOL_VERSION,
  type ResumeOrigin,
  type SpawnPlan,
  type SpawnPlanContext,
} from "../domain/agents";
import { paneAgentType, skillRootsOf, type Workspace } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { mintBridgeToken } from "./ids";
import { postbackCount } from "./postbacks";
import { stagedSkillsFor } from "./skillsStaging";
import type { PluginManager } from "./pluginManager";
import { useAppRuntime } from "./runtimeContext";
import { execCovers } from "../plugins/capabilities/execCovers";
import { useContributions } from "../plugins/react";

export type SpawnPluginAccess = Pick<
  PluginManager,
  "pluginHost" | "pluginRegistries"
>;

/** What `usePaneSpawnSpecs` hands back each render: every live pane's plan,
 *  plus the panes whose last build FAILED (so the deck can show an error tile
 *  with a retry). `failed` rides the same snapshot identity as `specs`, so a
 *  failure re-renders consumers with the new set in hand — no render-time
 *  side-channel into the module-level `failed` Set. */
export interface SpawnSpecs {
  specs: Record<string, SpawnPlan>;
  failed: ReadonlySet<string>;
}

/**
 * Spawn plans, built through the cli plugins' hooks ([F7]/[F8] v2).
 *
 * A pane's plan is the output of its agent plugin's `spawn.plan` /
 * `resume.plan` hook — argv, env, config injection — plus the HOST-owned
 * bridge arming: the single `KEEPDECK_BRIDGE` env var (inbox dir, pane
 * correlation, anti-forgery token) is appended here, never by a plugin;
 * plugins don't see the bridge.
 *
 * One plan per pane id, stable for the pane's life — module scope like the
 * id mints. Stability matters: the plan carries the pane's bridge token,
 * and re-building on a later render would orphan the token its reporter is
 * about to echo. Hooks are async, so plans land in the cache a beat after
 * the pane appears; the pane's terminal waits for its plan (mounting is
 * what spawns).
 */
const specs = new Map<string, SpawnPlan>();

/** Panes whose CURRENT build is in flight — a StrictMode re-run must not
 * build a second time. A manual resume reserves the same slot before its
 * first await, so the ordinary fresh-plan sweep cannot race it. */
const pending = new Set<string>();

/** Panes whose last plan build FAILED (a remote spawn.plan threw, which
 * propagates instead of silently degrading to a local spawn). The deck shows
 * an error tile rather than leaving the pane on "Waking up…" forever, and the
 * sweep skips them so a persistent error doesn't loop. Cleared by an explicit
 * retry (`clearPanePlanError`). */
const failed = new Set<string>();

/** Per-pane build generations make invalidation real: dropping a spec while
 * an async hook is running prevents that stale promise from installing its
 * result after a newer manual/fresh decision. */
const buildGenerations = new Map<string, number>();

function reserveBuild(paneId: string): number {
  const generation = (buildGenerations.get(paneId) ?? 0) + 1;
  buildGenerations.set(paneId, generation);
  pending.add(paneId);
  return generation;
}

async function buildAndCache(
  paneId: string,
  build: () => Promise<SpawnPlan>,
): Promise<boolean> {
  const generation = reserveBuild(paneId);
  try {
    const plan = await build();
    if (buildGenerations.get(paneId) !== generation) return false;
    pending.delete(paneId);
    specs.set(paneId, plan);
    failed.delete(paneId);
    return true;
  } catch (error) {
    if (buildGenerations.get(paneId) === generation) {
      pending.delete(paneId);
      // Record the failure so the deck can surface an error tile instead of
      // hanging on "Waking up…" — a remote spawn that can't build its plan
      // must not silently become a local one (the reason buildPlan rethrows).
      failed.add(paneId);
    }
    throw error;
  }
}

/** The pane-side facts a plan is built from — the hook input's shape minus
 * the resume session (that arrives with the resume request, not the pane). */
export interface PaneSpawnFacts extends SpawnPlanInput {
  /** Every spawn cwd of the WORKSPACE's panes — staging arms each with the
   * codex-facing `.agents/skills` symlink ("skills live in the launched
   * CLI's cwd, period"). Workspace-level data riding on pane facts so every
   * build path feeds the same staging call (and kept OFF the hook input:
   * `base` below lists its fields explicitly). */
  wsSkillRoots?: string[];
}

/** What a plan is FOR — fresh spawn, resume, or fork. Resume/fork carry
 * their session facts; the hook that runs is the variant's. */
type PlanVariant =
  | { kind: "spawn" }
  | { kind: "resume"; sessionId: string; origin: ResumeOrigin }
  | { kind: "fork"; sessionId: string; sourceCwd: string; transcriptPath?: string };

/** Build one plan through the agent's hook. A throwing SPAWN hook degrades
 * to a bare spawn (no identity) rather than a dead pane; a throwing resume
 * or fork hook REJECTS — degrading a requested continuation (or a fork whose
 * surgery failed) into a fresh conversation would be silent data loss. */
async function buildPlan(
  plugins: SpawnPluginAccess,
  agent: { entry: AgentContribution; pluginId: string },
  facts: PaneSpawnFacts,
  ctx: SpawnPlanContext,
  variant: PlanVariant = { kind: "spawn" },
): Promise<SpawnPlan> {
  const { entry, pluginId } = agent;
  const { paneId } = facts;
  const output: SpawnPlanOutput = {
    // Prefilled with the detected command; a hook may override (null = the
    // user's shell).
    command: entry.detect.bin,
    args: [],
    env: [],
    envDefaults: [],
  };
  // Staged shared skills are a host fact like the bridge — but delivered as
  // hook INPUT, because loading them is per-CLI dialect (a flag here, an env
  // var there), and dialects are exactly what hooks own. The full workspace
  // REF goes in: the memo keys on the never-reused instance (see
  // skillsStaging), the disk on the durable id.
  const skills = await stagedSkillsFor(
    facts.workspace,
    facts.wsSkillRoots ?? [],
  );
  const base: SpawnPlanInput = {
    paneId,
    workspace: facts.workspace,
    cwd: facts.cwd,
    ...(facts.branch ? { branch: facts.branch } : {}),
    ...(facts.yolo ? { yolo: true } : {}),
    ...(skills ? { skills } : {}),
    ...(facts.target ? { target: facts.target } : {}),
  };
  try {
    if (variant.kind === "resume") {
      await entry.hooks["resume.plan"]?.(
        { ...base, sessionId: variant.sessionId },
        output,
      );
    } else if (variant.kind === "fork") {
      const input: ForkPlanInput = {
        ...base,
        sessionId: variant.sessionId,
        sourceCwd: variant.sourceCwd,
        ...(variant.transcriptPath !== undefined && {
          transcriptPath: variant.transcriptPath,
        }),
      };
      await entry.hooks["fork.plan"]?.(input, output);
    } else {
      await entry.hooks["spawn.plan"]?.(base, output);
    }
  } catch (e) {
    // Resume/fork already propagate; a spawn degrades to bare so the pane
    // lives — UNLESS the pane is remote: a bare spawn would run the agent
    // LOCALLY (silently dropping the endpoint), a wrong-target execution the
    // user couldn't tell apart from a working remote pane. Surface it instead.
    if (variant.kind !== "spawn" || facts.target) throw e;
    log.warn(
      "web:agents",
      `${entry.id} spawn.plan failed — bare spawn: ${describeError(e)}`,
    );
    return { command: entry.detect.bin, args: [], env: [] };
  }
  // The hook's command must be covered by its plugin's exec capability —
  // warn for a trusted built-in (a bug to fix), CLAMP for an external
  // (falling back to the agent's own binary, which the registration gate
  // proved covered): a sandboxed plugin must not pick the program.
  const owner = plugins.pluginHost
    .getInstalled()
    .find((installed) => installed.manifest.id === pluginId);
  if (
    owner &&
    !execCovers(owner.manifest.capabilities, output.command ?? "$SHELL")
  ) {
    log.warn(
      "web:agents",
      `${entry.id}: plan command "${output.command}" is not exec-covered by ${pluginId}`,
    );
    if (owner.source === "external") {
      output.command = entry.detect.bin;
      output.args = [];
      output.env = [];
      output.envDefaults = [];
    }
  }
  // Bridge arming is host business: reporters read this var; hooks only
  // make the CLI load a reporter. Armed whenever the bridge exists.
  //
  // The token is PER PANE, not per build: a rebuild while the pane's
  // process is alive (observed: a double-revive rebuilding the resume
  // plan) must not orphan the token that process's reporters echo — every
  // postback would fail verification forever. An explicit restart drops
  // the spec first (`dropPaneSpawnSpec`), so a genuinely new process still
  // gets a fresh token.
  const token = ctx.bridgeDir
    ? (specs.get(paneId)?.token ?? mintBridgeToken())
    : null;
  const env: [string, string][] = token
    ? [
        ...output.env,
        [
          "KEEPDECK_BRIDGE",
          JSON.stringify({
            v: BRIDGE_PROTOCOL_VERSION,
            dir: ctx.bridgeDir,
            pane: paneId,
            token,
          }),
        ],
      ]
    : output.env;
  return {
    command: output.command,
    args: output.args,
    env,
    ...(output.envDefaults?.length ? { envDefaults: output.envDefaults } : {}),
    ...(token ? { token } : {}),
    ...(variant.kind === "resume"
      ? {
          resumeOf: variant.sessionId,
          resumeOrigin: variant.origin,
          postbackMark: postbackCount(paneId),
        }
      : variant.kind === "fork"
        ? { forkOf: variant.sessionId }
        : {}),
  };
}

/** Whether a pane's boot-restoration RESUME died before ever becoming a
 * session: the plan came from restore, and not one accepted postback has
 * arrived since it was built — a working resume always reports first (every
 * agent's startup hook posts through the bridge). Such an exit is the CLI
 * refusing the recorded id (deleted, GC'd, never materialized): the binding
 * is dead and the pane deserves the one-shot fresh fallback. Manual resumes
 * deliberately stay exited so another spawn only happens on another click. */
export function resumeDiedSilently(
  spec: SpawnPlan | undefined,
  currentPostbacks: number,
): boolean {
  return (
    spec?.resumeOrigin === "restore" &&
    !!spec.resumeOf &&
    spec.postbackMark === currentPostbacks
  );
}

/** Forget a pane's plan so the next build starts clean (the respawn-fresh
 * path after a dead resume). */
export function dropPaneSpawnSpec(paneId: string): void {
  specs.delete(paneId);
  pending.delete(paneId);
  failed.delete(paneId);
  buildGenerations.set(paneId, (buildGenerations.get(paneId) ?? 0) + 1);
}

/** Build and cache an exclusive RESUME plan for a dormant pane about to wake
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
  if (!agent) return false; // unavailable — the card keeps the pane dormant
  if (!agent.entry.hooks["resume.plan"]) {
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
  if (!agent.entry.hooks["fork.plan"]) {
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
 * The live panes' spawn plans, built lazily through the plugin hooks.
 * Dormant panes get theirs at revive time; a provisioning pane has no
 * working directory yet, so building would plan a spawn into the workspace
 * cwd — exactly the fallback the provisioning cards replaced.
 */
export function usePaneSpawnSpecs(
  workspaces: Workspace[],
  ctx: SpawnPlanContext | null,
  agentsReady: boolean,
  /** Any value whose change must re-run the build sweep — the respawn
   * path drops a plan from the module cache, which no other dep observes. */
  rebuildKey?: unknown,
): SpawnSpecs {
  const { plugins } = useAppRuntime();
  const contributions = useContributions(plugins.pluginRegistries.agents);
  // The cache version: bumped when a build lands, so the snapshot below
  // refreshes. (Resume plans land via `buildResumeSpec` before `revivePane`
  // flips deck state — that state change refreshes the snapshot instead.)
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!ctx || !agentsReady) return;
    let alive = true;
    for (const ws of workspaces) {
      const wsSkillRoots = skillRootsOf(ws);
      for (const pane of ws.panes) {
        if (pane.dormant || pane.provisioning) continue;
        if (specs.has(pane.id) || pending.has(pane.id) || failed.has(pane.id))
          continue;
        const agent = findAgent(plugins, paneAgentType(pane));
        if (!agent) continue; // the unavailable card blocks the terminal
        void buildAndCache(pane.id, () =>
          buildPlan(
            plugins,
            agent,
            {
              paneId: pane.id,
              workspace: { id: ws.id, instance: ws.instance },
              cwd: pane.cwd ?? ws.cwd,
              branch: pane.branch,
              yolo: pane.yolo,
              wsSkillRoots,
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
        )
          .then((committed) => {
            if (committed && alive) setTick((t) => t + 1);
          })
          .catch((error: unknown) => {
            log.error(
              "web:agents",
              `${pane.id} plan build failed: ${describeError(error)}`,
            );
            // A failed build recorded the pane in `failed`; bump the tick so
            // the snapshot refreshes and DeckStage re-reads peekPanePlanError
            // — without this the error tile never renders and the pane hangs
            // on "Waking up…" until some unrelated re-render happens.
            if (alive) setTick((t) => t + 1);
          });
      }
    }
    return () => {
      alive = false;
    };
  }, [workspaces, ctx, agentsReady, contributions, rebuildKey, plugins]);

  // A fresh snapshot object per cache change — cheap (small maps), and lets
  // consumers stay referentially honest. `failed` rides the SAME snapshot so a
  // failure re-renders consumers with the new set in hand (no render-time
  // side-channel into the module-level `failed` Set).
  return useMemo(() => {
    const snapshot: Record<string, SpawnPlan> = {};
    for (const ws of workspaces) {
      for (const pane of ws.panes) {
        const spec = specs.get(pane.id);
        if (spec) snapshot[pane.id] = spec;
      }
    }
    return { specs: snapshot, failed: new Set(failed) };
  }, [workspaces, tick, rebuildKey]);
}

/** The cached plan, if any (no building) — for the binding effect. */
export function peekPaneSpawnSpec(paneId: string): SpawnPlan | undefined {
  return specs.get(paneId);
}

/** Capture the first accepted local binding produced by a fork plan. This is
 * intentionally one-shot: a later `/new` in the same process is fresh usage. */
export function bindPaneSpawnSpecSession(
  paneId: string,
  sessionId: string,
): void {
  const spec = specs.get(paneId);
  if (!spec?.forkOf || spec.forkSessionId) return;
  specs.set(paneId, { ...spec, forkSessionId: sessionId });
}

/** Whether this exact provider session began with inherited counters. */
export function spawnPlanNeedsUsageBaseline(
  spec: Pick<SpawnPlan, "resumeOf" | "forkSessionId"> | undefined,
  sessionId: string,
): boolean {
  return spec?.resumeOf === sessionId || spec?.forkSessionId === sessionId;
}

/** Whether this pane's last plan build FAILED (a remote spawn.plan threw).
 *  The deck renders an error tile instead of "Waking up…" — the build won't
 *  be retried until the user asks (`clearPanePlanError`). */
export function peekPanePlanError(paneId: string): boolean {
  return failed.has(paneId);
}

/** Clear a pane's failed-plan flag and invalidate any in-flight build so the
 *  next sweep rebuilds it (the retry button on the error tile). */
export function clearPanePlanError(paneId: string): void {
  failed.delete(paneId);
  pending.delete(paneId);
  buildGenerations.set(paneId, (buildGenerations.get(paneId) ?? 0) + 1);
}

/** Test isolation. */
export function resetPaneSpawnSpecs(): void {
  specs.clear();
  pending.clear();
  failed.clear();
  buildGenerations.clear();
}

function findAgent(
  plugins: SpawnPluginAccess,
  agentType: string,
): { entry: AgentContribution; pluginId: string } | undefined {
  return plugins.pluginRegistries.agents
    .list()
    .find((c) => c.entry.id === agentType);
}
