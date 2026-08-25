import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Session-binding events ([F7]/[F8] session identity v2). A pane's own agent
 * process reports its session id through the CLI bridge (hook/plugin armed
 * at spawn via the `KEEPDECK_BRIDGE` env var); the Rust watcher parses the
 * envelope and emits this event. The constant mirrors `SESSION_BOUND_EVENT`
 * in src-tauri/src/bridge/wire.rs.
 */
export const SESSION_BOUND_EVENT = "deck://session/bound";

/** Mirrors the Rust `SessionBound` (camelCase). The token is the per-pane
 * bridge secret — the binding hook verifies it against the pane's spawn plan
 * before believing the postback. It proves the reporter runs somewhere under
 * this pane, which is NOT the same as being the pane's own agent session:
 * the two fields below are what the deck judges that by. */
export interface SessionBound {
  paneId: string;
  sessionId: string;
  token: string;
  /** The session's transcript/rollout file when the reporter knows it —
   * what the codex usage tailer follows. */
  transcriptPath?: string;
  /** Which CLI reported this, as its arming site named it. Guaranteed by the
   * bridge, which refuses an unsigned binding the same way it refuses one on
   * the opaque channels. */
  agent: string;
  /** The CLI's own word for why the session started, verbatim — each agent's
   * normalizer maps its own vocabulary. */
  source?: string;
  /** Which PROCESS reported it, opaque and only ever compared for equality:
   * the secret is inherited by the pane's whole process tree, so this is what
   * a nested run of the same agent cannot forge. Absent when the reporter
   * cannot name its own process. */
  reporter?: string;
}

/** Subscribe to session bindings; resolves to the unlisten function. */
export function onSessionBound(
  handler: (bound: SessionBound) => void,
): Promise<() => void> {
  return listen<SessionBound>(SESSION_BOUND_EVENT, (event) =>
    handler(event.payload),
  );
}

/** The per-install spawn-plan context (mirrors the Rust `SpawnContextDto`):
 * this run's bridge inbox and the port its surface answers on, resolved
 * once at boot. */
export interface SpawnContextDto {
  /** This run's bridge inbox; "" = unavailable. */
  bridgeDir: string;
  /** The port its surface answers on; 0 = unavailable. */
  bridgePort: number;
}

export function spawnContext(): Promise<SpawnContextDto> {
  return invoke("session_spawn_context");
}

/**
 * The inbox this pane's reporters own, created before the agent starts.
 *
 * One directory per pane rather than one per run. It buys no secrecy — panes
 * run as the same user and can read each other's files whatever the layout —
 * but it makes an ANSWER addressed by pane: the deck decides whose directory
 * a reply lands in, so an envelope naming somebody else's correlation
 * reaches nobody. It also keeps one agent's stray glob out of another's mail.
 */
export function paneBridgeDir(paneId: string): Promise<string> {
  return invoke("bridge_pane_dir", { pane: paneId });
}

