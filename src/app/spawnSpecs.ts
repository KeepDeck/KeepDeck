import { useEffect, useMemo, useState } from "react";
import type {
  AgentContribution,
  SpawnPlanInput,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import {
  BRIDGE_PROTOCOL_VERSION,
  type ResumeOrigin,
  type SpawnPlan,
  type SpawnPlanContext,
} from "../domain/agents";
import { paneAgentType, type Workspace } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { mintBridgeToken } from "./ids";
import { postbackCount } from "./postbacks";
import type { PluginManager } from "./pluginManager";
import { useAppRuntime } from "./runtimeContext";
import { execCovers } from "../plugins/capabilities/execCovers";
import { useContributions } from "../plugins/react";

export type SpawnPluginAccess = Pick<
  PluginManager,
  "pluginHost" | "pluginRegistries"
>;

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
    return true;
  } catch (error) {
    if (buildGenerations.get(paneId) === generation) pending.delete(paneId);
    throw error;
  }
}

/** The pane-side facts a plan is built from — the hook input's shape minus
 * the resume session (that arrives with the resume request, not the pane). */
export type PaneSpawnFacts = SpawnPlanInput;

/** Build one plan through the agent's hook; a throwing hook degrades to a
 * bare spawn (no identity) rather than a dead pane. */
async function buildPlan(
  plugins: SpawnPluginAccess,
  agent: { entry: AgentContribution; pluginId: string },
  facts: PaneSpawnFacts,
  ctx: SpawnPlanContext,
  resumeId?: string | null,
  resumeOrigin?: ResumeOrigin,
): Promise<SpawnPlan> {
  const { entry, pluginId } = agent;
  const { paneId } = facts;
  const output: SpawnPlanOutput = {
    // Prefilled with the detected command; a hook may override (null = the
    // user's shell).
    command: entry.detect.bin,
    args: [],
    env: [],
  };
  const base: SpawnPlanInput = {
    paneId,
    workspace: facts.workspace,
    cwd: facts.cwd,
    ...(facts.branch ? { branch: facts.branch } : {}),
    ...(facts.yolo ? { yolo: true } : {}),
  };
  try {
    if (resumeId) {
      await entry.hooks["resume.plan"]?.(
        { ...base, sessionId: resumeId },
        output,
      );
    } else {
      await entry.hooks["spawn.plan"]?.(base, output);
    }
  } catch (e) {
    log.warn(
      "web:agents",
      `${entry.id} ${resumeId ? "resume" : "spawn"}.plan failed — bare spawn: ${describeError(e)}`,
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
    }
  }
  // Bridge arming is host business: reporters read this var; hooks only
  // make the CLI load a reporter. Armed whenever the bridge exists.
  const token = ctx.bridgeDir ? mintBridgeToken() : null;
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
    ...(token ? { token } : {}),
    ...(resumeId && resumeOrigin
      ? {
          resumeOf: resumeId,
          resumeOrigin,
          postbackMark: postbackCount(paneId),
        }
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
    buildPlan(plugins, agent, facts, ctx, resumeId, origin),
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
): Record<string, SpawnPlan> {
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
      for (const pane of ws.panes) {
        if (pane.dormant || pane.provisioning) continue;
        if (specs.has(pane.id) || pending.has(pane.id)) continue;
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
            },
            ctx,
          ),
        )
          .then((committed) => {
            if (committed && alive) setTick((t) => t + 1);
          })
          .catch((error: unknown) =>
            log.error(
              "web:agents",
              `${pane.id} plan build failed: ${describeError(error)}`,
            ),
          );
      }
    }
    return () => {
      alive = false;
    };
  }, [workspaces, ctx, agentsReady, contributions, rebuildKey, plugins]);

  // A fresh snapshot object per cache change — cheap (small maps), and lets
  // consumers stay referentially honest.
  return useMemo(() => {
    const snapshot: Record<string, SpawnPlan> = {};
    for (const ws of workspaces) {
      for (const pane of ws.panes) {
        const spec = specs.get(pane.id);
        if (spec) snapshot[pane.id] = spec;
      }
    }
    return snapshot;
  }, [workspaces, tick, rebuildKey]);
}

/** The cached plan, if any (no building) — for the binding effect. */
export function peekPaneSpawnSpec(paneId: string): SpawnPlan | undefined {
  return specs.get(paneId);
}

/** Test isolation. */
export function resetPaneSpawnSpecs(): void {
  specs.clear();
  pending.clear();
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
