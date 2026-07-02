import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Session-binding events ([F7]/[F8] session identity v2). A pane's own agent
 * process reports its session id through the KeepDeck spool (hook/plugin armed
 * at spawn); the Rust watcher parses the postback and emits this event. The
 * constant mirrors `SESSION_BOUND_EVENT` in src-tauri/src/sessions.rs.
 */
export const SESSION_BOUND_EVENT = "deck://session/bound";

/** Mirrors the Rust `SessionPostback` (camelCase). */
export interface SessionBound {
  paneId: string;
  sessionId: string;
}

/** Subscribe to session bindings; resolves to the unlisten function. */
export function onSessionBound(
  handler: (bound: SessionBound) => void,
): Promise<() => void> {
  return listen<SessionBound>(SESSION_BOUND_EVENT, (event) =>
    handler(event.payload),
  );
}

/** The spool directory reporters write into — injected as `KEEPDECK_SPOOL`
 * into agent spawns. */
export function sessionSpoolDir(): Promise<string> {
  return invoke<string>("session_spool_dir");
}
