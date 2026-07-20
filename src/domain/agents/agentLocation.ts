import type { AgentType } from "./agents";
import type { SessionHandle } from "../journal";

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

/** How a pane of this deck already holds a candidate path: it RUNS there
 * (`"worktree"` — the dir is a live git worktree, that's how panes get a cwd),
 * or it's the target of an in-flight/failed worktree create (`"provisioning"`
 * — nothing exists to attach to yet). `null` → free. */
export type Occupancy = "worktree" | "provisioning" | null;

/** Classify a candidate worktree path from its probe. Pure. Occupancy is
 * known synchronously and outranks every probe outcome — even mid-probe —
 * UNLESS the user explicitly chose to attach anyway (`attachAnyway`). The
 * override needs no probe: `"worktree"` occupancy itself proves the dir is a
 * worktree (a pane runs in it), while a `"provisioning"` target can never be
 * attached. An existing EMPTY dir counts as "new" — git can create a worktree
 * into it; only a non-empty non-worktree dir is blocked. */
export function classifyLocation(
  path: string,
  probe: PathProbe | null,
  occupancy: Occupancy = null,
  attachAnyway = false,
): LocationKind {
  if (!path.trim()) return "main";
  if (occupancy === "worktree" && attachAnyway) return "existing";
  if (occupancy) return "occupied";
  if (!probe) return "checking";
  if (!probe.exists) return "new";
  if (probe.isWorktree) return "existing";
  return probe.empty ? "new" : "blocked";
}

/** Whether the base-branch input can seed a new worktree: empty defers to the
 * repo HEAD (today's default), a known local branch is picked verbatim, and
 * anything else is a typo to catch IN the dialog — not a failed card after it
 * closed. A `null` list (branch listing unavailable) validates everything:
 * degrading to free text beats blocking the dialog on a dead IPC. Pure. */
export function isKnownBaseBranch(
  input: string,
  branches: string[] | null,
): boolean {
  const name = input.trim();
  if (!name || branches === null) return true;
  return branches.includes(name);
}

/** Whether Create is allowed for a classified location + current branch input.
 * A new worktree needs a branch name and a usable base ([`isKnownBaseBranch`]
 * — only "new" creates a branch, so only it consults `baseOk`); a
 * still-probing, occupied or blocked path can't be created. Pure. */
export function canCreateAgent(
  kind: LocationKind,
  branch: string,
  baseOk = true,
): boolean {
  switch (kind) {
    case "main":
    case "existing":
      return true;
    case "new":
      return branch.trim().length > 0 && baseOk;
    case "checking":
    case "occupied":
    case "blocked":
      return false;
  }
}

/** The resolved location for a new agent, chosen in the "+ Agent" dialog. */
export type AgentLocation =
  | { kind: "main" }
  | {
      kind: "new";
      path: string;
      branch: string;
      /** The local branch the worktree's new branch forks from; absent/empty
       * = the repo HEAD at create time (the default since before the picker). */
      baseBranch?: string;
    }
  | { kind: "existing"; path: string; branch: string };

/** The dialog's "Start from" choice: a fresh conversation, or an existing
 * session of the SELECTED agent continued in place (resume) or copied into
 * a new one (fork) ([F8] spawn-time continuation). */
export type SessionStartMode = "new" | "resume" | "fork";

/** Why a listed session can't be RESUMED (forking stays possible — it is
 * exactly the escape hatch for these): its directory is gone, it never
 * recorded one, or a pane already owns the binding. */
export type ResumeBlock = "dir-gone" | "no-cwd" | "claimed" | null;

/** Whether Create is allowed for the "Start from" choice. New sessions
 * always pass; continuing needs a picked session, and resume additionally a
 * resumable one ([`ResumeBlock`] null). Pure — the location gate
 * ([`canCreateAgent`]) composes with this, except for resume, which ignores
 * the location entirely (it runs in the session's recorded cwd). */
export function canStartFromSession(
  mode: SessionStartMode,
  picked: boolean,
  block: ResumeBlock,
): boolean {
  if (mode === "new") return true;
  if (!picked) return false;
  return mode === "fork" || block === null;
}

/** One row of the dialog's session picker: the handle the flows consume
 * plus what the row renders. */
export interface SessionPickRow {
  handle: SessionHandle;
  /** Store mtime (ms) — the row's recency stamp. */
  mtime: number;
}

/** What the "+ Agent" dialog returns for one new agent. */
export interface AgentDialogResult {
  agentType: AgentType;
  /** Optional custom display name; blank falls back to the derived title. */
  name: string;
  location: AgentLocation;
  /** Run with permission prompts disabled — only ever true for an agent
   * whose plugin declares YOLO support (the dialog gates the toggle). */
  yolo: boolean;
  /** Continue an existing session instead of starting fresh: resume runs it
   * in its recorded cwd (`location` is then advisory only), fork copies it
   * into the chosen location. Absent = a fresh conversation. */
  session?: { mode: "resume" | "fork"; handle: SessionHandle };
}
