/**
 * App-wide id mints. Pane and workspace seq numbers must be unique for the
 * whole app lifetime — pane ids key the PTY input registry and the
 * agent↔worktree records — so the counters live at module scope (like the
 * paneInput registry) instead of as refs inside a component.
 */
let nextAgentSeq = 1;
let nextWorkspaceSeq = 1;

/** Reserve `count` consecutive agent seq numbers; returns the first. */
export function mintAgentSeqs(count: number): number {
  const start = nextAgentSeq;
  nextAgentSeq += count;
  return start;
}

/** Reserve the next agent seq number. */
export function mintAgentSeq(): number {
  return mintAgentSeqs(1);
}

/** Reserve the next workspace seq number. */
export function mintWorkspaceSeq(): number {
  return nextWorkspaceSeq++;
}

/** Raise the agent mint to at least `min` (deck restore, [F7]). Never lowers —
 * ids issued before a (late) hydrate must stay unique. */
export function seedAgentSeq(min: number): void {
  nextAgentSeq = Math.max(nextAgentSeq, min);
}

/** Raise the workspace mint to at least `min` (deck restore, [F7]). */
export function seedWorkspaceSeq(min: number): void {
  nextWorkspaceSeq = Math.max(nextWorkspaceSeq, min);
}

/** Mint a fresh agent session id — the app-layer randomness source behind
 * `buildSpawnPlan`'s `mintId` (claude wants a lowercase UUID, which
 * `crypto.randomUUID` guarantees). */
export function mintSessionId(): string {
  return crypto.randomUUID();
}

/** Mint a per-spawn bridge token (`buildSpawnPlan`'s `mintToken`) — the
 * secret a reporter must echo for its postback to be believed. */
export function mintBridgeToken(): string {
  return crypto.randomUUID();
}
