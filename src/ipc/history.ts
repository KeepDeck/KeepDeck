import { invoke } from "@tauri-apps/api/core";
import type { AgentType } from "../domain/agents";

/** Tri-state pre-resume validation (mirrors the Rust `PresenceDto`): only a
 * definitive `"absent"` may drop a session binding — `"unknown"` means the
 * store couldn't answer and the binding must be kept. */
export type SessionPresence = "present" | "absent" | "unknown";

/** Whether `agent`'s session `id` is still in its store for `dir` —
 * pre-resume validation ([F7]/[F8]): a stale binding degrades to a fresh
 * spawn instead of resuming into an error. */
export function sessionPresence(
  agent: AgentType,
  id: string,
  dir: string,
): Promise<SessionPresence> {
  return invoke<SessionPresence>("history_presence", { agent, id, dir });
}
