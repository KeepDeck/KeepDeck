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
}

/**
 * Tell the native side which process `pane`'s reports are pinned to — its
 * children then count as the pane's — or that there is none (`undefined`).
 * A reporter that named itself with something other than a process id pins
 * nothing native.
 */
export function vouchPaneProcess(pane: string, reporter: string | undefined): Promise<void> {
  const pid = reporter !== undefined && /^\d+$/.test(reporter) ? Number(reporter) : null;
  return invoke("pty_vouch", { pane, pid });
}
