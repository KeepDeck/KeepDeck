import { useEffect, useRef, useState } from "react";
import { FALLBACK_AGENTS, resumeArgs, type AgentInfo } from "../domain/agents";
import type { Pane } from "../domain/panes";
import { latestSession } from "../ipc/history";
import { probeWorktree } from "../ipc/worktree";
import type { Deck } from "./useDeck";

/**
 * Lazy revival of restored panes ([F7]): when a workspace with dormant panes
 * is (or becomes) active, wake each one so its terminal mounts and spawns —
 * RESUMING its recorded agent session where one is known (the persisted
 * binding, else the newest session for the pane's directory), falling back to
 * a fresh spawn ([F8] strategy: native resume by default).
 *
 * Before waking, the pane's directory is probed — a pane whose worktree is
 * gone stays dormant and is reported in `blocked`, so its tile can explain
 * itself and offer a fresh start in the workspace cwd instead.
 */
export interface ReviveApi {
  /** paneId → the missing directory (the dormant tile's note). */
  blocked: Record<string, string>;
  /** Spawn args per revived pane — the resume recipe ([F8]); absent = fresh. */
  argsByPane: Record<string, string[]>;
  /** Detach the pane from the missing worktree and start it fresh in the
   * workspace cwd. */
  startFresh(wsId: string, paneId: string): void;
}

export function useRevive(deck: Deck, agents: AgentInfo[]): ReviveApi {
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const [argsByPane, setArgsByPane] = useState<Record<string, string[]>>({});
  // Revivals in flight — re-renders while one is pending must not double-run.
  const waking = useRef(new Set<string>());
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const active = deck.workspaces.find((w) => w.id === deck.activeId);

  useEffect(() => {
    if (!active) return;

    /** Resolve the resume recipe and wake one pane. */
    const wake = async (pane: Pane, dir: string) => {
      const agentType = pane.agentType ?? "claude";
      // The persisted binding wins; without one, ask the agent's store for the
      // newest session recorded in this directory ([F7] §3).
      let sessionId = pane.session?.id ?? null;
      if (!sessionId) {
        sessionId =
          (await latestSession(agentType, dir).catch(() => null))?.id ?? null;
      }
      // The catalog fetch races the boot restore — fall back to the static
      // recipes so an early revive still resumes (prefixes are per-agent
      // constants, not machine-dependent like install detection).
      const info =
        agentsRef.current.find((a) => a.id === agentType) ??
        FALLBACK_AGENTS.find((a) => a.id === agentType);
      const args = sessionId ? resumeArgs(info, sessionId) : null;
      if (args) setArgsByPane((prev) => ({ ...prev, [pane.id]: args }));
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
  }, [active, blocked]);

  const startFresh = (wsId: string, paneId: string) => {
    setBlocked(({ [paneId]: _gone, ...rest }) => rest);
    deckRef.current.resetPaneLocation(wsId, paneId);
    deckRef.current.revivePane(wsId, paneId);
  };

  return { blocked, argsByPane, startFresh };
}
