import { useEffect, useRef, useState } from "react";
import type { AgentInfo, SpawnPlanContext } from "../domain/agents";
import { findWorkspace, paneAgentType, type Pane } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { probeWorktree } from "../ipc/worktree";
import { buildResumeSpec } from "./spawnSpecs";
import { useAppRuntime } from "./runtimeContext";
import type { Deck } from "./useDeck";

/**
 * Lazy revival of restored panes ([F7]): when a workspace with dormant panes
 * is (or becomes) active, wake each one so its terminal mounts and spawns —
 * RESUMING its recorded agent session where one is known (the persisted,
 * hook-reported binding) and starting FRESH otherwise — an unbound pane is
 * never matched to a session by its directory, which would resume a FOREIGN
 * conversation whenever panes share a cwd. A resume plan is
 * pre-registered in the spawn-spec cache; a fresh wake takes the default plan
 * the render pass builds (which assigns/arms session identity, v2).
 *
 * Before waking, the pane's directory is probed — a pane whose worktree is
 * gone stays dormant and is reported in `blocked`, so its tile can explain
 * itself and offer a fresh start in the workspace cwd instead.
 */
export interface ReviveApi {
  /** paneId → the missing directory (the dormant tile's note). */
  blocked: Record<string, string>;
  /** Detach the pane from the missing worktree and start it fresh in the
   * workspace cwd. */
  startFresh(wsId: string, paneId: string): void;
}

export function useRevive(
  deck: Deck,
  agents: AgentInfo[],
  ctx: SpawnPlanContext | null,
  /** The agent catalog reflects the booted plugin system — waking anything
   * earlier would misjudge every pane's agent as unknown. */
  agentsReady: boolean,
): ReviveApi {
  const { plugins } = useAppRuntime();
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  // Revivals in flight — re-renders while one is pending must not double-run.
  const waking = useRef(new Set<string>());
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const active = findWorkspace(deck.workspaces, deck.activeId);

  // Reap entries whose pane is gone (closed directly, or with its workspace):
  // ids are never reused, so without this the map only ever grows.
  useEffect(() => {
    setBlocked((prev) => {
      const live = new Set(
        deck.workspaces.flatMap((w) => w.panes.map((p) => p.id)),
      );
      const kept = Object.entries(prev).filter(([paneId]) => live.has(paneId));
      return kept.length === Object.keys(prev).length
        ? prev
        : Object.fromEntries(kept);
    });
  }, [deck.workspaces]);

  // Re-run when the catalog's id set changes: re-enabling a cli plugin must
  // wake the panes its absence kept dormant, without an app restart.
  const agentIds = agents
    .map((a) => a.id)
    .sort()
    .join("\n");

  useEffect(() => {
    // Wait for the spawn context (a resume plan built without it would miss
    // the agent's identity mechanism) AND the catalog (see `agentsReady`).
    if (!active || !ctx || !agentsReady) return;

    /** Resolve the resume session and wake one pane. */
    const wake = async (pane: Pane, dir: string) => {
      const agentType = paneAgentType(pane);
      // A recorded binding is TRUSTED: it came from the pane's own process
      // (the reporter posts at session creation), so it existed. If it was
      // deleted out from under us since, the resume fails VISIBLY in the
      // terminal — accepted, rare, and uniform across agents; the app never
      // reads an agent's session store. An unbound pane starts FRESH:
      // matching the newest session in the directory would resume a FOREIGN
      // conversation whenever panes share a cwd (the default — a worktree
      // is optional).
      const sessionId = pane.session?.id ?? null;
      log.info(
        "web:revive",
        `${pane.id} (${agentType}): ` +
          (sessionId ? `resume ${sessionId}` : "fresh"),
      );
      if (sessionId && ctxRef.current) {
        // Built through the agent plugin's resume.plan hook and cached
        // BEFORE the pane wakes — the mounting terminal reads it.
        await buildResumeSpec(
          plugins,
          agentType,
          {
            paneId: pane.id,
            workspace: { id: active.id, instance: active.instance },
            cwd: dir,
            branch: pane.branch,
            yolo: pane.yolo,
          },
          ctxRef.current,
          sessionId,
          "restore",
        );
      }
      deckRef.current.revivePane(active.id, pane.id);
    };

    for (const pane of active.panes) {
      if (!pane.dormant || pane.id in blocked || waking.current.has(pane.id))
        continue;
      // An agent no plugin provides must NOT wake: the spawn would run the
      // bare id as a command, and the presence check would answer "absent"
      // for the unknown store and WIPE a binding that resumes fine once the
      // plugin returns. The pane stays dormant behind its
      // "agent unavailable" card.
      const agentType = paneAgentType(pane);
      if (!agentsRef.current.some((a) => a.id === agentType)) continue;
      const dir = pane.cwd ?? active.cwd;
      waking.current.add(pane.id);
      void probeWorktree(dir)
        .then((probe) => {
          if (probe.exists) return wake(pane, dir);
          log.warn(
            "web:revive",
            `${pane.id}: directory gone ${dir} → blocked tile`,
          );
          setBlocked((b) => ({ ...b, [pane.id]: dir }));
        })
        // A failed probe errs on the side of waking the pane fresh — worst
        // case the spawn itself reports the broken directory in the terminal.
        .catch((e) => {
          log.warn(
            "web:revive",
            `${pane.id}: probe failed, waking fresh: ${describeError(e)}`,
          );
          deckRef.current.revivePane(active.id, pane.id);
        })
        .finally(() => waking.current.delete(pane.id));
    }
  }, [active, blocked, ctx, agentsReady, agentIds, plugins]);

  const startFresh = (wsId: string, paneId: string) => {
    setBlocked(({ [paneId]: _gone, ...rest }) => rest);
    deckRef.current.resetPaneLocation(wsId, paneId);
    deckRef.current.revivePane(wsId, paneId);
  };

  return { blocked, startFresh };
}
