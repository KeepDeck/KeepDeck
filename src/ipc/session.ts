import { Channel, invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust `SessionEvent` (serde `tag = "type"`, camelCase). */
export type SessionEvent =
  | { type: "output"; bytes: number[] }
  | { type: "exit"; success: boolean; code: number | null };

export interface SpawnOptions {
  /** Program to run; omit/null to use the user's shell. */
  command?: string | null;
  args?: string[];
  /** Extra environment on top of the inherited one (the [F7]/[F8] session
   * identity plan: pane id, spool path, reporter activation). */
  env?: [string, string][];
  cwd?: string | null;
  cols: number;
  rows: number;
}

/** A live PTY session backed by the Rust core. */
export interface Session {
  readonly id: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

const encoder = new TextEncoder();

/**
 * Spawn a session and stream its events to `onEvent`. Output and the final exit
 * arrive over a per-session channel, so panes never share an event bus.
 */
export async function spawnSession(
  opts: SpawnOptions,
  onEvent: (event: SessionEvent) => void,
): Promise<Session> {
  const channel = new Channel<SessionEvent>();
  channel.onmessage = onEvent;

  const id = await invoke<string>("session_spawn", {
    spec: {
      command: opts.command ?? null,
      args: opts.args ?? [],
      env: opts.env ?? [],
      cwd: opts.cwd ?? null,
      cols: opts.cols,
      rows: opts.rows,
    },
    onEvent: channel,
  });

  return {
    id,
    write: (data) =>
      invoke("session_write", { id, data: Array.from(encoder.encode(data)) }),
    resize: (cols, rows) => invoke("session_resize", { id, cols, rows }),
    close: () => invoke("session_close", { id }),
  };
}
