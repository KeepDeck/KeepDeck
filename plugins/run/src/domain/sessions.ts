import { runEnv, type RunPreset } from "./presets";
import type { WorkspaceRef } from "@keepdeck/plugin-api";

/**
 * Run sessions — the model behind the Run panel.
 *
 * Strictly OUTSIDE the agent world: a run session is not a pane, joins no grid,
 * records no agent session identity and is never persisted — after a restart
 * the panel offers the presets again instead of resurrecting dead processes.
 * Only the platform services are shared with agents: the session spawn (a PTY
 * with a group kill behind close) and the port allocator, both reached through
 * the plugin's `ctx.services`.
 */

/** Where a run session is in its life. `stopping` covers the SIGTERM grace
 * window after an explicit Stop, until the exit event lands. */
export type RunStatus =
  | { kind: "running" }
  | { kind: "stopping" }
  | { kind: "exited"; code: number | null }
  | { kind: "failed"; message: string };

export interface RunSession {
  /** Manager-minted (`rs-N`), unique across the plugin activation's lifetime. */
  id: string;
  /** The workspace whose presets launched it — its runs die with it. */
  workspace: WorkspaceRef;
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

export function sameWorkspace(
  left: WorkspaceRef,
  right: WorkspaceRef,
): boolean {
  return left.id === right.id && left.instance === right.instance;
}

/** What to launch: a preset (id + command snapshot) or an ad-hoc line. */
export interface RunRequest {
  presetId?: string;
  command: string;
  name: string;
}

/** One row of the Run tab's merged Commands list: a preset fused with its live
 * state. `session` is the CURRENT target's instance (it drives the row's glyph
 * and meta — the row always answers "what would happen HERE"); `elsewhere` are
 * instances in other targets, rendered as indented child rows with their own
 * controls. A row without a preset is an orphan: its preset was deleted while
 * the session lived. */
export interface CommandRow {
  preset?: RunPreset;
  session?: RunSession;
  elsewhere: RunSession[];
}

/** Fuse the workspace's presets with its live sessions for `currentTarget`.
 * Every preset gets a row (idle ones too); sessions whose preset is gone trail
 * as orphan rows so a running process never becomes invisible. */
export function commandRows(
  presets: readonly RunPreset[],
  sessions: readonly RunSession[],
  currentTarget: string,
): CommandRow[] {
  const claimed = new Set<string>();
  const rows: CommandRow[] = presets.map((preset) => {
    const mine = sessions.filter((s) => s.presetId === preset.id);
    for (const s of mine) claimed.add(s.id);
    const session = mine.find((s) => s.worktree === currentTarget);
    return {
      preset,
      ...(session && { session }),
      elsewhere: mine.filter((s) => s !== session),
    };
  });
  for (const s of sessions) {
    if (!claimed.has(s.id)) rows.push({ session: s, elsewhere: [] });
  }
  return rows;
}

/** Spawn options for a run command: the user's shell, non-interactive `-c` — no
 * job control, so the whole command tree shares one process group and a close
 * kills everything. Size is a placeholder; the log view resizes the PTY to its
 * real grid on attach. */
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
