/**
 * When each pane's PTY was spawned (epoch ms) — the [F7]/[F8] session-binding
 * window: a pane's agent session is the newest store entry for its
 * (agent, cwd) written AFTER this instant. Module scope (like the paneInput
 * registry): pane ids are app-unique and the writer (`TerminalPane`, at spawn)
 * is far from the reader (`useSessionBinding`).
 */
const spawnedAt = new Map<string, number>();

/** Record that `paneId`'s PTY is being spawned right now. */
export function recordPaneSpawn(paneId: string): void {
  spawnedAt.set(paneId, Date.now());
}

/** When `paneId`'s PTY spawned, or undefined if it never did (dormant pane). */
export function paneSpawnedAt(paneId: string): number | undefined {
  return spawnedAt.get(paneId);
}

/** Drop the record when the pane unmounts. */
export function forgetPaneSpawn(paneId: string): void {
  spawnedAt.delete(paneId);
}
