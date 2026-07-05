import { useEffect, useRef, useState } from "react";
import { onWorktreeHead, unwatchWorktree, watchWorktree } from "../ipc/worktree";
import { worktreeCwds } from "../domain/deck";
import type { Deck } from "./useDeck";

/**
 * Live branch badge: keeps each worktree pane's `branch` in sync with the
 * worktree's REAL git position. The Rust side watches every registered
 * worktree's HEAD and emits `deck://worktree/head` on each checkout inside it;
 * this hook is the two halves of the frontend contract:
 *
 * - a subscriber recording each event on the pane(s) running at that path;
 * - a watch lifecycle that diffs the deck's worktree cwds — new pane: watch,
 *   closed pane: unwatch. Registration makes the watcher emit the current
 *   state, so a branch switched while KeepDeck wasn't running reconciles at
 *   boot without any extra pass.
 *
 * Watches are registered only once the subscription is live — the
 * registration-time emit would otherwise be lost.
 */
export function useWorktreeHead(deck: Deck): void {
  const deckRef = useRef(deck);
  deckRef.current = deck;

  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onWorktreeHead(({ path, branch, head }) => {
      const d = deckRef.current;
      // The event may outlive its pane (checkout raced a close) — no match,
      // nothing to record.
      for (const ws of d.workspaces) {
        for (const pane of ws.panes) {
          if (pane.cwd === path) {
            d.setPaneHead(ws.id, pane.id, {
              branch: branch ?? undefined,
              head: head ?? undefined,
            });
          }
        }
      }
    }).then((u) => {
      if (disposed) {
        u();
      } else {
        unlisten = u;
        setReady(true);
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Paths whose watch registration succeeded (or is in flight). A failed
  // registration (worktree dir gone) is dropped so a later deck change
  // retries — the dir may have been restored meanwhile.
  const watched = useRef(new Set<string>());
  useEffect(() => {
    if (!ready) return;
    const current = worktreeCwds(deck.workspaces);
    for (const path of current) {
      if (watched.current.has(path)) continue;
      watched.current.add(path);
      watchWorktree(path).catch(() => watched.current.delete(path));
    }
    for (const path of [...watched.current]) {
      if (current.has(path)) continue;
      watched.current.delete(path);
      void unwatchWorktree(path).catch(() => {});
    }
  }, [ready, deck.workspaces]);
}
