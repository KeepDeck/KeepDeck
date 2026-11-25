/**
 * The ids the page mints itself — random tokens, which need no counter and no
 * coordination. A pane's id is a counter, and the lifecycle machine mints it.
 */

/**
 * `prefix-` and a random token, drawn again while `taken` holds it. Random
 * rather than counted, so nothing a team or a workspace leaves behind — a
 * task board, the replies addressed to it, a store kept under its id — can
 * pass to a later one: no counter to release when one goes, or to forget
 * across a restart.
 */
function mintTokenId(prefix: string, taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    if (!taken.has(id)) return id;
  }
}

/** Mint a team id: `team-` and a random token. `taken` is every team id the
 * deck holds. */
export function mintTeamId(taken: ReadonlySet<string>): string {
  return mintTokenId("team", taken);
}

/** Mint a workspace id: `ws-` and a random token, never one the deck holds.
 * Older decks hold `ws-N`; those stay valid and are never handed out again
 * either, since no counter mints them any more. */
export function mintWorkspaceId(taken: ReadonlySet<string>): string {
  return mintTokenId("ws", taken);
}

/** Mint a per-pane MCP secret — what an injected client announces so the
 * deck can name the pane behind a connection (see `SpawnPlan.mcpToken`). */
export function mintMcpToken(): string {
  return crypto.randomUUID();
}

/** Mint a per-pane bridge token — the secret a pane's reporters name in
 * their envelopes, which the bridge's door counts only from that pane's live
 * terminal (see `SpawnPlan.token`). */
export function mintBridgeToken(): string {
  return crypto.randomUUID();
}

/** Mint a task uid — the task's own identity, global and permanent
 * (`Task.uid`): a whole UUID, since tasks of every workspace share its
 * space and none is ever handed out twice. */
export function mintTaskUid(): string {
  return crypto.randomUUID();
}
