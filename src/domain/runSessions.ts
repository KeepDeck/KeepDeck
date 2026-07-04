import { runEnv } from "./runPresets";

/**
 * Run sessions — the model behind the Run panel (experimental run presets).
 *
 * Strictly OUTSIDE the agent world: a run session is not a pane, joins no
 * grid, records no agent session identity and is never persisted — after a
 * restart the panel offers the presets again instead of resurrecting dead
 * processes. Only the generic layers are shared with agents: the session IPC
 * (PTY spawn with a group kill behind close) and the port allocator.
 */

/** Where a run session is in its life. `stopping` covers the SIGTERM grace
 * window after an explicit Stop, until the exit event lands. */
export type RunStatus =
  | { kind: "running" }
  | { kind: "stopping" }
  | { kind: "exited"; code: number | null }
  | { kind: "failed"; message: string };

export interface RunSession {
  /** Manager-minted (`run-N`), unique across the app's lifetime. */
  id: string;
  /** The workspace whose presets launched it — its runs die with it. */
  wsId: string;
  /** Display name: the preset's, or the command line for ad-hoc runs. */
  name: string;
  /** The preset this run came from; ad-hoc runs have none. */
  presetId?: string;
  /** The command line snapshot at launch. */
  command: string;
  /** The directory it runs in (a worktree, or the workspace folder). */
  worktree: string;
  branch?: string;
  /** KEEPDECK_PORT base; absent when allocation failed (the env then simply
   * lacks the variable — no invented default). */
  port?: number;
  status: RunStatus;
}

/** What to launch: a preset (id + command snapshot) or an ad-hoc line. */
export interface RunRequest {
  presetId?: string;
  command: string;
  name: string;
}

/** Spawn options for a run command: the user's shell, non-interactive `-c` —
 * no job control, so the whole command tree shares one process group and a
 * close kills everything. Size is a placeholder; the log view resizes the
 * PTY to its real grid on attach. */
export function runSpawnOptions(session: {
  command: string;
  worktree: string;
  branch?: string;
  port?: number;
}): {
  command: null;
  args: string[];
  env: [string, string][];
  cwd: string;
  cols: number;
  rows: number;
} {
  return {
    command: null,
    args: ["-c", session.command],
    env: runEnv({
      worktree: session.worktree,
      branch: session.branch,
      port: session.port,
    }),
    cwd: session.worktree,
    cols: 120,
    rows: 30,
  };
}
