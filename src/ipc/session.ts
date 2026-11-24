import { Channel, invoke } from "@tauri-apps/api/core";
import { bytesFromBase64 } from "../domain/terminal/base64";
import type { LaunchOwner } from "./generated/lifecycle/LaunchOwner";
import type { PermitId } from "./generated/lifecycle/PermitId";
import type { SessionId } from "./generated/lifecycle/SessionId";

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
}

/** How an exact-session stop ended (mirrors the Rust `Stopped`): it exited,
 * it had to be killed, its end could not be confirmed, or there was no such
 * session. */
export type Stopped = "exited" | "forced" | "unconfirmed" | "unknown";

/** A live session of the sessions machine. */
export interface Session {
  readonly id: SessionId;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  /** Stop this exact session; answers once it is over. */
  stop(): Promise<Stopped>;
}

const encoder = new TextEncoder();

/**
 * Start a session through the spawn door: `permit` is the launch lease the
 * machine granted `owner`, spent by the door's admission — refused, nothing
 * starts and this rejects. Output and the final exit arrive over a
 * per-session channel, so panes never share an event bus.
 */
export async function openSession(
  opts: SpawnOptions,
  permit: PermitId,
  owner: LaunchOwner,
  onEvent: (event: SessionEvent) => void,
): Promise<Session> {
  const channel = new Channel<WireSessionEvent>();
  channel.onmessage = (event) => onEvent(fromWire(event));
  const id = await invoke<SessionId>("pty_open", {
    spec: {
      command: opts.command ?? null,
      args: opts.args ?? [],
      env: opts.env ?? [],
      envDefaults: opts.envDefaults ?? [],
      cwd: opts.cwd ?? null,
      cols: opts.cols,
      rows: opts.rows,
    },
    permit,
    owner,
    onEvent: channel,
  });
  return {
    id,
    write: (data) => invoke("pty_write", { id, data: Array.from(encoder.encode(data)) }),
    resize: (cols, rows) => invoke("pty_resize", { id, cols, rows }),
    stop: () => invoke<Stopped>("pty_stop", { id }),
  };
}
