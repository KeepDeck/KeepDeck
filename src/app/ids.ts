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
