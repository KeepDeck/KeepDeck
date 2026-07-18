import { nextIdSequence } from "../domain/idSequence";

/**
 * App-wide pane id mint. Pane seq numbers must be unique for the whole app
 * lifetime — pane ids key the PTY input registry and the agent↔worktree
 * records — so the counter lives at module scope (like the paneInput
 * registry) instead of as a ref inside a component.
 */
let nextAgentSeq = 1;

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

/**
 * The next workspace sequence from the live deck. Removing the highest
 * workspace releases its sequence; gaps below the maximum remain untouched.
 */
export function mintWorkspaceSeq(
  workspaceIds: readonly string[],
): number | null {
  return nextIdSequence(workspaceIds, "ws");
}

/** Raise the agent mint to at least `min` (deck restore, [F7]). Never lowers —
 * ids issued before a (late) hydrate must stay unique. */
export function seedAgentSeq(min: number): void {
  nextAgentSeq = Math.max(nextAgentSeq, min);
}

/** Mint a per-spawn bridge token (`buildSpawnPlan`'s `mintToken`) — the
 * secret a reporter must echo for its postback to be believed. */
export function mintBridgeToken(): string {
  return crypto.randomUUID();
}
