import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Session-binding events ([F7]/[F8] session identity v2). A pane's own agent
 * process reports its session id through the CLI bridge (hook/plugin armed
 * at spawn via the `KEEPDECK_BRIDGE` env var); the Rust watcher parses the
 * envelope and emits this event. The constant mirrors `SESSION_BOUND_EVENT`
 * in src-tauri/src/bridge.rs.
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
 * this run's bridge inbox, resolved once at boot. */
export function spawnContext(): Promise<{ bridgeDir: string }> {
  return invoke("session_spawn_context");
}
