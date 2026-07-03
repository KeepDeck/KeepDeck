import { useEffect, useRef, useState } from "react";
import type { AgentInfo } from "../domain/agents";
import type { Pane } from "../domain/panes";
import { buildSpawnPlan, type SpawnPlanContext } from "../domain/spawnPlans";
import { latestSession, sessionExists } from "../ipc/history";
import { probeWorktree } from "../ipc/worktree";
import { setPaneSpawnSpec } from "./spawnSpecs";
import type { Deck } from "./useDeck";

/**
 * Lazy revival of restored panes ([F7]): when a workspace with dormant panes
 * is (or becomes) active, wake each one so its terminal mounts and spawns —
 * RESUMING its recorded agent session where one is known (the persisted
 * binding, else the newest session for the pane's directory), falling back to
 * a fresh spawn ([F8] strategy: native resume by default). A resume plan is
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
): ReviveApi {
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  // Revivals in flight — re-renders while one is pending must not double-run.
  const waking = useRef(new Set<string>());
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const active = deck.workspaces.find((w) => w.id === deck.activeId);

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

  useEffect(() => {
    // Wait for the spawn context: a resume plan built without it would miss
    // the agent's identity mechanism (e.g. codex hook args).
    if (!active || !ctx) return;

    /** Resolve the resume session and wake one pane. */
    const wake = async (pane: Pane, dir: string) => {
      const agentType = pane.agentType ?? "claude";
      const recorded = pane.session?.id ?? null;
      let sessionId: string | null = null;
      if (recorded) {
        // Validate before resuming — an assigned id whose session was never
        // written (a pane the user never spoke to), or one the agent GC'd.
        // Either way the pane starts FRESH: falling back to
        // newest-in-directory here would resurrect someone else's
        // conversation (the empty-claude-pane bug). A failed CHECK trusts
        // the binding (worst case: the resume exits visibly).
        const alive = await sessionExists(agentType, recorded, dir).catch(
          () => true,
        );
        sessionId = alive ? recorded : null;
        // Drop the dead binding — a pane must not keep pointing at a ghost:
        // the binding hook refuses to overwrite an existing session, so a
        // stale one would block the fresh spawn's identity from ever being
        // recorded (the lost-"test"-conversation bug).
        if (!alive) {
          deckRef.current.setPaneSession(active.id, pane.id, null);
        }
      } else {
        // Never bound (pre-v2 deck, reporter never fired): best-effort —
        // the newest session recorded for this directory.
        sessionId =
          (await latestSession(agentType, dir).catch(() => null))?.id ?? null;
      }
      if (sessionId && ctxRef.current) {
        setPaneSpawnSpec(
          pane.id,
          buildSpawnPlan(agentType, pane.id, ctxRef.current, {
            resumeId: sessionId,
            agents: agentsRef.current,
          }),
        );
      }
      deckRef.current.revivePane(active.id, pane.id);
    };

    for (const pane of active.panes) {
      if (!pane.dormant || pane.id in blocked || waking.current.has(pane.id))
        continue;
      const dir = pane.cwd ?? active.cwd;
      waking.current.add(pane.id);
      void probeWorktree(dir)
        .then((probe) => {
          if (probe.exists) return wake(pane, dir);
          setBlocked((b) => ({ ...b, [pane.id]: dir }));
        })
        // A failed probe errs on the side of waking the pane fresh — worst
        // case the spawn itself reports the broken directory in the terminal.
        .catch(() => deckRef.current.revivePane(active.id, pane.id))
        .finally(() => waking.current.delete(pane.id));
    }
  }, [active, blocked, ctx]);

  const startFresh = (wsId: string, paneId: string) => {
    setBlocked(({ [paneId]: _gone, ...rest }) => rest);
    deckRef.current.resetPaneLocation(wsId, paneId);
    deckRef.current.revivePane(wsId, paneId);
  };

  return { blocked, startFresh };
}
