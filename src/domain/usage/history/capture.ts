/**
 * Where a provider session came from — the ONE thing that decides whether its
 * first cumulative report is a baseline or real usage (the core applies it).
 *
 * - `inherited` — resume or fork: the counters already include work the
 *   ledger may already hold. Always seeds.
 * - `fresh` — this run's own spawn minted the session. Nothing about it can
 *   be in the ledger, so its first turn is real usage and is COUNTED.
 * - `unknown` — no spawn plan for the pane: attached or restored, so the
 *   session may predate this run. Seeds whenever the ledger is incomplete.
 */
export type UsageSessionOrigin = "fresh" | "inherited" | "unknown";

/** The deck's facts about the pane a usage report came from. */
export interface UsageCaptureContext {
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
  paneId: string;
  paneName: string;
  sessionId: string;
  origin: UsageSessionOrigin;
  worktree?: {
    path: string;
    branch?: string;
    repo: string;
  };
}
