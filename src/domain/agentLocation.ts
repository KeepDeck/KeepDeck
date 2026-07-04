import type { AgentType } from "./agents";

/** Backend probe of a candidate worktree path (mirrors the Rust `PathProbe`). */
export interface PathProbe {
  /** Whether the path exists on disk. */
  exists: boolean;
  /** Whether it's a git work tree an agent could attach to. */
  isWorktree: boolean;
  /** Whether an existing non-worktree dir is empty — a worktree can be created
   * into an empty dir, but not into a non-empty one. */
  empty: boolean;
  /** The branch checked out there, when it's a worktree on a branch. */
  branch: string | null;
}

/**
 * How the entered worktree path resolves in the "+ Agent" dialog ([F2] — the
 * per-agent worktree/main choice is DERIVED FROM THE PATH, not a toggle):
 * an empty path runs in the workspace's main repo; a free path creates a new
 * worktree; an existing worktree is attached; anything else is unusable.
 */
export type LocationKind =
  | "main" // empty path → run in the workspace's main repo (no worktree)
  | "checking" // path entered, probe still in flight
  | "new" // path is free → create a new worktree there
  | "existing" // path is a git worktree → attach the agent to it ([F12])
  | "occupied" // a pane already runs in this directory → can't take a second
  | "blocked"; // path exists but isn't a worktree → can't use it

/** Classify a candidate worktree path from its probe. Pure. Occupancy (a pane
 * of this deck already runs there) is known synchronously and outranks every
 * probe outcome — even mid-probe — UNLESS the user explicitly chose to attach
 * anyway (`attachAnyway`), which is honored only for a confirmed existing
 * worktree: a pane still provisioning its target dir has nothing to attach to.
 * An existing EMPTY dir counts as "new" — git can create a worktree into it;
 * only a non-empty non-worktree dir is blocked. */
export function classifyLocation(
  path: string,
  probe: PathProbe | null,
  occupied = false,
  attachAnyway = false,
): LocationKind {
  if (!path.trim()) return "main";
  if (occupied && !(attachAnyway && probe?.isWorktree)) return "occupied";
  if (!probe) return "checking";
  if (!probe.exists) return "new";
  if (probe.isWorktree) return "existing";
  return probe.empty ? "new" : "blocked";
}

/** Whether Create is allowed for a classified location + current branch input.
 * A new worktree needs a branch name; a still-probing, occupied or blocked
 * path can't be created. Pure. */
export function canCreateAgent(kind: LocationKind, branch: string): boolean {
  switch (kind) {
    case "main":
    case "existing":
      return true;
    case "new":
      return branch.trim().length > 0;
    case "checking":
    case "occupied":
    case "blocked":
      return false;
  }
}

/** The resolved location for a new agent, chosen in the "+ Agent" dialog. */
export type AgentLocation =
  | { kind: "main" }
  | { kind: "new"; path: string; branch: string }
  | { kind: "existing"; path: string; branch: string };

/** What the "+ Agent" dialog returns for one new agent. */
export interface AgentDialogResult {
  agentType: AgentType;
  /** Optional custom display name; blank falls back to the derived title. */
  name: string;
  location: AgentLocation;
}
