import { useEffect, useRef, useState } from "react";
import { gitWatchPaths, type GitPosition } from "../domain/deck";
import { onWorktreeHead, unwatchWorktree, watchWorktree } from "../ipc/worktree";
import type { WorktreeHead } from "../ipc/worktree";
import type { Deck } from "./useDeck";

function positionFromEvent(head: WorktreeHead): GitPosition | null {
  if (head.branch) return { branch: head.branch };
  if (head.head) return { head: head.head };
  return null;
}

function samePosition(a: GitPosition | undefined, b: GitPosition | null): boolean {
  return (a?.branch ?? null) === (b?.branch ?? null) && (a?.head ?? null) === (b?.head ?? null);
}

/**
 * Runtime git HEAD observations, keyed by the pane execution path derived from
 * deck domain state (`pane.cwd ?? ws.cwd`). The deck remains durable model state;
 * current branch/detached HEAD is an app-runtime observation used by UI badges
 * and close-time worktree cleanup.
 */
export function useGitHead(deck: Deck): ReadonlyMap<string, GitPosition> {
  const [heads, setHeads] = useState<ReadonlyMap<string, GitPosition>>(
    () => new Map(),
  );
  const [ready, setReady] = useState(false);
  // Paths whose watch registration succeeded (or is in flight). A failed
  // registration is dropped so the next deck change retries it; non-git paths
  // simply never receive a head entry and therefore render no badge.
  const watched = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onWorktreeHead((head) => {
      if (!watched.current.has(head.path)) return;
      const next = positionFromEvent(head);
      setHeads((prev) => {
        if (samePosition(prev.get(head.path), next)) return prev;
        const copy = new Map(prev);
        if (next) copy.set(head.path, next);
        else copy.delete(head.path);
        return copy;
      });
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

  useEffect(() => {
    if (!ready) return;
    const current = gitWatchPaths(deck.workspaces);
    for (const path of current) {
      if (watched.current.has(path)) continue;
      watched.current.add(path);
      watchWorktree(path).catch(() => {
        watched.current.delete(path);
        setHeads((prev) => {
          if (!prev.has(path)) return prev;
          const copy = new Map(prev);
          copy.delete(path);
          return copy;
        });
      });
    }
    for (const path of [...watched.current]) {
      if (current.has(path)) continue;
      watched.current.delete(path);
      setHeads((prev) => {
        if (!prev.has(path)) return prev;
        const copy = new Map(prev);
        copy.delete(path);
        return copy;
      });
      void unwatchWorktree(path).catch(() => {});
    }
  }, [ready, deck.workspaces]);

  return heads;
}
