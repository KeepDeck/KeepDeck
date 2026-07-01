import type { AgentType } from "../agents";

/** Backend probe of a candidate worktree path (mirrors the Rust `PathProbe`). */
export interface PathProbe {
  /** Whether the path exists on disk. */
  exists: boolean;
  /** Whether it's a git work tree an agent could attach to. */
  isWorktree: boolean;
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
  | "blocked"; // path exists but isn't a worktree → can't use it

/** Classify a candidate worktree path from its probe. Pure. */
export function classifyLocation(
  path: string,
  probe: PathProbe | null,
): LocationKind {
  if (!path.trim()) return "main";
  if (!probe) return "checking";
  if (!probe.exists) return "new";
  return probe.isWorktree ? "existing" : "blocked";
}

/** Whether Create is allowed for a classified location + current branch input.
 * A new worktree needs a branch name; a still-probing or blocked path can't be
 * created. Pure. */
export function canCreateAgent(kind: LocationKind, branch: string): boolean {
  switch (kind) {
    case "main":
    case "existing":
      return true;
    case "new":
      return branch.trim().length > 0;
    case "checking":
    case "blocked":
      return false;
  }
}

/** Split a full worktree path into the parent dir + leaf folder the
 * `worktree_create` command takes (`baseDir` + `dir`). Trailing slashes are
 * ignored; a bare name resolves against the current dir. Pure. */
export function splitWorktreePath(path: string): { baseDir: string; dir: string } {
  const trimmed = path.trim().replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return { baseDir: ".", dir: trimmed };
  return { baseDir: trimmed.slice(0, slash) || "/", dir: trimmed.slice(slash + 1) };
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
