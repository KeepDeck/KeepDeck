import { useEffect, useRef } from "react";
import { latestSession } from "../ipc/history";
import { paneSpawnedAt } from "./paneSpawns";
import type { Deck } from "./useDeck";

/** Binding looks after spawn: the agent needs a moment to create its session
 * entry; a slow starter gets a second, later look. */
const ATTEMPT_DELAYS_MS = [6_000, 30_000];

/**
 * Spawn-diff session binding ([F7] §3): for every live agent pane, find the
 * store entry its agent created AFTER the pane spawned and record it in the
 * deck as the pane's resume key — bound while the pane is alive, so a restart
 * never has to guess. Rebinds are wanted, not avoided: resuming a claude
 * session continues under a NEW id, and the fresher binding must win before
 * the next save (same-id rebinds are reducer no-ops).
 */
export function useSessionBinding(deck: Deck): void {
  const deckRef = useRef(deck);
  deckRef.current = deck;
  // Panes whose binding chain already started (spawn-scoped, not attempt-scoped).
  const started = useRef(new Set<string>());
  const timers = useRef(new Set<number>());

  useEffect(() => {
    for (const ws of deck.workspaces) {
      for (const pane of ws.panes) {
        if (pane.dormant || !pane.agentType) continue;
        const spawned = paneSpawnedAt(pane.id);
        if (spawned === undefined || started.current.has(pane.id)) continue;
        started.current.add(pane.id);

        const agentType = pane.agentType;
        const dir = pane.cwd ?? ws.cwd;
        const attempt = (n: number) => {
          const timer = window.setTimeout(
            () => {
              timers.current.delete(timer);
              // The pane may be gone by now — skip quietly (and stop retrying).
              const stillThere = deckRef.current.workspaces
                .find((w) => w.id === ws.id)
                ?.panes.some((p) => p.id === pane.id);
              if (!stillThere) return;
              void latestSession(agentType, dir, spawned)
                .catch(() => null)
                .then((hit) => {
                  if (hit) {
                    deckRef.current.setPaneSession(ws.id, pane.id, {
                      id: hit.id,
                      boundAt: new Date().toISOString(),
                    });
                  } else if (n + 1 < ATTEMPT_DELAYS_MS.length) {
                    attempt(n + 1);
                  }
                });
            },
            Math.max(0, spawned + ATTEMPT_DELAYS_MS[n] - Date.now()),
          );
          timers.current.add(timer);
        };
        attempt(0);
      }
    }
  }, [deck.workspaces]);

  // Unmount: cancel whatever is still pending.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);
}
