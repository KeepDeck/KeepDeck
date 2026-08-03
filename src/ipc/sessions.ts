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
  /** Which CLI reported this, as its arming site named it. Absent from a
   * reporter that predates the field. */
  agent?: string;
  /** The CLI's own word for why the session started, verbatim — each agent's
   * normalizer maps its own vocabulary. */
  source?: string;
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
