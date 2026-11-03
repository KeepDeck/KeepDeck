import { Channel, invoke } from "@tauri-apps/api/core";
import { bytesFromBase64 } from "../domain/terminal/base64";

/** An event of a live session, as the page uses it. */
export type SessionEvent =
  | { type: "output"; bytes: Uint8Array }
  | { type: "exit"; success: boolean; code: number | null };

/** Mirrors the Rust `SessionEvent` (serde `tag = "type"`, camelCase). Output
 * crosses as base64: as a JSON array of numbers every terminal byte cost the
 * page 13–18 bytes of garbage, and a large chunk overflowed into a queue in
 * the core with no bound (see `OUTPUT_MESSAGE_BYTES` in session.rs). */
type WireSessionEvent =
  | { type: "output"; data: string }
  | { type: "exit"; success: boolean; code: number | null };

/** The one place a wire event turns into the page's: output is decoded here,
 * once, so no consumer converts bytes itself. */
function fromWire(event: WireSessionEvent): SessionEvent {
  return event.type === "output"
    ? { type: "output", bytes: bytesFromBase64(event.data) }
    : event;
}

export interface SpawnOptions {
  /** Program to run; omit/null to use the user's shell. */
  command?: string | null;
  args?: string[];
  /** Extra environment on top of the inherited one (the [F7]/[F8] session
   * identity plan: the KEEPDECK_BRIDGE var, reporter activation). */
  env?: [string, string][];
  /** Env pairs applied only when the key is NOT already inherited — a
   * user-owned variable beats a default (mirrors PtySpec.env_defaults). */
  envDefaults?: [string, string][];
  cwd?: string | null;
  cols: number;
  rows: number;
  /** The pane this terminal is. The bridge takes a pane's reports only from
   * processes running in its terminal — a daemon that inherited the pane's
   * environment and detached is not one. Omit for a terminal that is no
   * pane's. */
  pane?: string | null;
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
  const channel = new Channel<WireSessionEvent>();
  channel.onmessage = (event) => onEvent(fromWire(event));

  const id = await invoke<string>("session_spawn", {
    spec: {
      command: opts.command ?? null,
      args: opts.args ?? [],
      env: opts.env ?? [],
      envDefaults: opts.envDefaults ?? [],
      cwd: opts.cwd ?? null,
      cols: opts.cols,
      rows: opts.rows,
      pane: opts.pane ?? null,
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

/**
 * Tell the native side which process `pane`'s reports are pinned to — its
 * children then count as the pane's — or that there is none (`undefined`).
 * A reporter that named itself with something other than a process id pins
 * nothing native.
 */
export function vouchPaneProcess(pane: string, reporter: string | undefined): Promise<void> {
  const pid = reporter !== undefined && /^\d+$/.test(reporter) ? Number(reporter) : null;
  return invoke("session_vouch", { pane, pid });
}
