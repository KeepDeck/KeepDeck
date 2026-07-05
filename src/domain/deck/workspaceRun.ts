/**
 * The workspace's run configuration — the deck document's sub-schema behind
 * the experimental run presets. A workspace owns named shell commands
 * ("presets") plus an optional one-time `setup` command; they are persisted
 * with the deck, so deleting the workspace deletes them structurally. What
 * EXECUTING a preset means lives in domain/run — this module owns only the
 * stored shape and its tolerant read.
 */

/** One named launch command of a workspace. */
export interface RunPreset {
  /** Stable id (`run-N` within the workspace) — what a pane records. */
  id: string;
  name: string;
  /** The shell command line, run via `$SHELL -c` in the pane's worktree. */
  command: string;
}

/** A workspace's run configuration. */
export interface WorkspaceRun {
  /** One-time worktree-preparation command (deps, .env copies), executed by
   * the provisioning flow after `worktree_create`; failure → the Retry card. */
  setup?: string;
  presets: RunPreset[];
}

/**
 * Tolerant read of a persisted workspace-run value: `null` for a shape that
 * isn't one (the workspace simply has no run config), and individually
 * malformed presets are dropped rather than rejecting the deck — mirroring
 * how persist degrades an unknown agentType. Always parsed regardless of the
 * experiment flag: turning the experiment off must never drop stored data on
 * the next save.
 */
export function readWorkspaceRun(value: unknown): WorkspaceRun | null {
  if (!isRecord(value) || !Array.isArray(value.presets)) return null;
  const presets: RunPreset[] = [];
  for (const p of value.presets) {
    if (
      isRecord(p) &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      typeof p.command === "string" &&
      p.command.trim() !== ""
    ) {
      presets.push({ id: p.id, name: p.name, command: p.command });
    }
  }
  const run: WorkspaceRun = { presets };
  if (typeof value.setup === "string" && value.setup.trim() !== "") {
    run.setup = value.setup;
  }
  return run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
