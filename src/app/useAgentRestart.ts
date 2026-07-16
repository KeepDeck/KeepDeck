import { useRef, useState } from "react";
import type { AgentRestartMode, SpawnPlanContext } from "../domain/agents";
import { findWorkspace, paneAgentType } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { postbackCount } from "./postbacks";
import { closePane } from "./ptyManager";
import {
  buildResumeSpec,
  dropPaneSpawnSpec,
  peekPaneSpawnSpec,
  resumeDiedSilently,
} from "./spawnSpecs";
import { useAppRuntime } from "./runtimeContext";
import type { Deck } from "./useDeck";

export interface AgentRestartApi {
  /** Per-pane mount generation. Bumping one remounts its terminal view after
   * the manager has retired the exited PTY entry. */
  epochs: ReadonlyMap<string, number>;
  /** Restart only on an explicit exited-card action. */
  restart(wsId: string, paneId: string, mode: AgentRestartMode): Promise<void>;
  /** Preserve the existing one-shot recovery for a rejected BOOT resume.
   * Ordinary exits and manual resumes are ineligible and remain visible. */
  /** Returns whether this exit IS the one-shot boot-resume recovery (a fresh
   * respawn is being handled here) — callers treat a `true` as "not a crash". */
  recoverRejectedResume(
    wsId: string,
    paneId: string,
    code: number | null,
  ): boolean;
}

interface RestartTarget {
  wsId: string;
  paneId: string;
  agentType: string;
  cwd: string;
  branch: string | undefined;
  sessionId: string | null;
}

/** Manual agent restart orchestration. Runtime state lives here rather than in
 * the durable Pane model: restarting replaces a PTY + spawn plan, not the
 * pane/worktree/session facts the deck persists. */
export function useAgentRestart(
  deck: Deck,
  ctx: SpawnPlanContext | null,
): AgentRestartApi {
  const { plugins } = useAppRuntime();
  const [epochs, setEpochs] = useState<ReadonlyMap<string, number>>(new Map());
  const inFlight = useRef(new Set<string>());
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const bumpEpoch = (paneId: string) =>
    setEpochs((current) =>
      new Map(current).set(paneId, (current.get(paneId) ?? 0) + 1),
    );

  const restartFresh = async (target: RestartTarget) => {
    // Invalidate the old bridge token before anything can report late from the
    // retired process. The next spawn-plan sweep is triggered by the epoch.
    dropPaneSpawnSpec(target.paneId);
    await closePane(target.paneId);
    if (!findTarget(deckRef.current, target.wsId, target.paneId)) return;
    // Fresh means fresh on the next app launch too. Keep cwd/branch/worktree;
    // only the exact session binding is replaced by the new reporter later.
    deckRef.current.setPaneSession(target.wsId, target.paneId, null);
    bumpEpoch(target.paneId);
  };

  const restartResume = async (target: RestartTarget) => {
    const spawnCtx = ctxRef.current;
    if (!spawnCtx) throw new Error("Agent spawn context is unavailable");
    if (!target.sessionId) return restartFresh(target);

    // Remove the old token immediately, then prepare a plan that explicitly
    // stays exited if the CLI rejects its id (manual means no auto fallback).
    dropPaneSpawnSpec(target.paneId);
    const planBuilt = await buildResumeSpec(
      plugins,
      target.agentType,
      target.paneId,
      target.wsId,
      target.cwd,
      target.branch,
      spawnCtx,
      target.sessionId,
      "manual",
    );

    const current = findTarget(deckRef.current, target.wsId, target.paneId);
    if (!current) {
      dropPaneSpawnSpec(target.paneId);
      return;
    }
    if (!sameResumeTarget(current, target)) {
      dropPaneSpawnSpec(target.paneId);
      throw new Error("Agent changed while its restart was being prepared");
    }
    const spec = peekPaneSpawnSpec(target.paneId);
    if (
      !planBuilt ||
      spec?.resumeOrigin !== "manual" ||
      spec.resumeOf !== target.sessionId
    ) {
      // A missing agent or a failed resume hook must not silently degrade a
      // user-requested continuation into a fresh conversation.
      dropPaneSpawnSpec(target.paneId);
      throw new Error("Agent could not prepare a resume plan");
    }

    await closePane(target.paneId);
    const afterClose = findTarget(deckRef.current, target.wsId, target.paneId);
    if (!afterClose || !sameResumeTarget(afterClose, target)) {
      dropPaneSpawnSpec(target.paneId);
      return;
    }
    bumpEpoch(target.paneId);
  };

  const restart = async (
    wsId: string,
    paneId: string,
    mode: AgentRestartMode,
  ) => {
    if (inFlight.current.has(paneId)) return;
    const target = findTarget(deckRef.current, wsId, paneId);
    if (!target) return;
    inFlight.current.add(paneId);
    try {
      const effectiveMode =
        mode === "resume" && target.sessionId ? "resume" : "fresh";
      log.info("web:restart", `${paneId}: manual ${effectiveMode}`);
      if (effectiveMode === "resume") await restartResume(target);
      else await restartFresh(target);
    } catch (error) {
      log.warn(
        "web:restart",
        `${paneId}: restart failed: ${describeError(error)}`,
      );
      throw error;
    } finally {
      inFlight.current.delete(paneId);
    }
  };

  const recoverRejectedResume = (
    wsId: string,
    paneId: string,
    code: number | null,
  ): boolean => {
    const spec = peekPaneSpawnSpec(paneId);
    if (!resumeDiedSilently(spec, postbackCount(paneId))) return false;
    if (inFlight.current.has(paneId)) return true;
    const target = findTarget(deckRef.current, wsId, paneId);
    if (!target) return false;

    inFlight.current.add(paneId);
    log.warn(
      "web:revive",
      `${paneId}: resume of ${spec?.resumeOf} exited (${code ?? "?"}) without reporting — respawning fresh`,
    );
    deckRef.current.setPaneSession(wsId, paneId, null);
    dropPaneSpawnSpec(paneId);
    void closePane(paneId)
      .then(() => {
        if (findTarget(deckRef.current, wsId, paneId)) bumpEpoch(paneId);
      })
      .finally(() => inFlight.current.delete(paneId));
    return true;
  };

  return { epochs, restart, recoverRejectedResume };
}

function findTarget(
  deck: Deck,
  wsId: string,
  paneId: string,
): RestartTarget | null {
  const workspace = findWorkspace(deck.workspaces, wsId);
  const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
  if (!workspace || !pane) return null;
  return {
    wsId,
    paneId,
    agentType: paneAgentType(pane),
    cwd: pane.cwd ?? workspace.cwd,
    branch: pane.branch,
    sessionId: pane.session?.id ?? null,
  };
}

function sameResumeTarget(
  current: RestartTarget,
  expected: RestartTarget,
): boolean {
  return (
    current.agentType === expected.agentType &&
    current.cwd === expected.cwd &&
    current.branch === expected.branch &&
    current.sessionId === expected.sessionId
  );
}
