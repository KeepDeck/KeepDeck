import { useEffect, useMemo, useState } from "react";
import type { AgentContribution, SpawnPlanOutput } from "@keepdeck/plugin-api";
import {
  BRIDGE_PROTOCOL_VERSION,
  type SpawnPlan,
  type SpawnPlanContext,
} from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { mintBridgeToken } from "./ids";
import { pluginRegistries } from "./pluginManager";
import { useContributions } from "../plugins/react";

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

/** Panes whose build is in flight — a StrictMode re-run must not build a
 * second time. Never cleared on unmount: the build completes and caches
 * regardless, which is exactly the stability we want. */
const pending = new Set<string>();

/** Build one plan through the agent's hook; a throwing hook degrades to a
 * bare spawn (no identity) rather than a dead pane. */
async function buildPlan(
  agent: AgentContribution,
  paneId: string,
  wsId: string,
  cwd: string,
  branch: string | undefined,
  ctx: SpawnPlanContext,
  resumeId?: string | null,
): Promise<SpawnPlan> {
  const output: SpawnPlanOutput = {
    // Prefilled with the detected command; a hook may override (null = the
    // user's shell).
    command: agent.detect.bin,
    args: [],
    env: [],
  };
  const base = { paneId, wsId, cwd, ...(branch ? { branch } : {}) };
  try {
    if (resumeId) {
      await agent.hooks["resume.plan"]?.({ ...base, sessionId: resumeId }, output);
    } else {
      await agent.hooks["spawn.plan"]?.(base, output);
    }
  } catch (e) {
    log.warn(
      "web:agents",
      `${agent.id} ${resumeId ? "resume" : "spawn"}.plan failed — bare spawn: ${describeError(e)}`,
    );
    return { command: agent.detect.bin, args: [], env: [] };
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
  };
}

/** Build and cache a RESUME plan for a dormant pane about to wake — replaces
 * any cached plan (revive decides resume-vs-fresh, and its word wins). */
export async function buildResumeSpec(
  agentType: string,
  paneId: string,
  wsId: string,
  cwd: string,
  branch: string | undefined,
  ctx: SpawnPlanContext,
  resumeId: string,
): Promise<void> {
  const agent = findAgent(agentType);
  if (!agent) return; // unavailable — the card keeps the pane dormant
  specs.set(
    paneId,
    await buildPlan(agent, paneId, wsId, cwd, branch, ctx, resumeId),
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
): Record<string, SpawnPlan> {
  const contributions = useContributions(pluginRegistries.agents);
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
        const agent = findAgent(pane.agentType ?? "claude");
        if (!agent) continue; // the unavailable card blocks the terminal
        pending.add(pane.id);
        void buildPlan(
          agent,
          pane.id,
          ws.id,
          pane.cwd ?? ws.cwd,
          pane.branch,
          ctx,
        ).then((plan) => {
          pending.delete(pane.id);
          specs.set(pane.id, plan);
          if (alive) setTick((t) => t + 1);
        });
      }
    }
    return () => {
      alive = false;
    };
  }, [workspaces, ctx, agentsReady, contributions]);

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
  }, [workspaces, tick]);
}

/** The cached plan, if any (no building) — for the binding effect. */
export function peekPaneSpawnSpec(paneId: string): SpawnPlan | undefined {
  return specs.get(paneId);
}

/** Test isolation. */
export function resetPaneSpawnSpecs(): void {
  specs.clear();
  pending.clear();
}

function findAgent(agentType: string): AgentContribution | undefined {
  return pluginRegistries.agents
    .list()
    .find((c) => c.entry.id === agentType)?.entry;
}
