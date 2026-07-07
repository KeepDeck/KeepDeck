import { invoke } from "@tauri-apps/api/core";
import type { AgentType } from "../domain/agents";

/** A discovered agent session (mirrors the Rust `HistoryHitDto`, camelCase). */
export interface HistoryHit {
  /** The agent's own session id — what its resume flag accepts. */
  id: string;
  /** Store mtime of the session, epoch milliseconds. */
  modifiedMs: number;
}

/**
 * The most recent session of `agent` recorded for working directory `dir`.
 * Resolves `null` when nothing is found — a missing store is not an error.
 */
export function latestSession(
  agent: AgentType,
  dir: string,
): Promise<HistoryHit | null> {
  return invoke<HistoryHit | null>("history_latest", { agent, dir });
}

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
