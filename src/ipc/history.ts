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
 * The most recent session of `agent` recorded for working directory `dir`,
 * optionally only when written after `sinceMs` (the [F7]/[F8] spawn-diff
 * binding window). Resolves `null` when nothing is found — a missing store is
 * not an error.
 */
export function latestSession(
  agent: AgentType,
  dir: string,
  sinceMs?: number,
): Promise<HistoryHit | null> {
  return invoke<HistoryHit | null>("history_latest", {
    agent,
    dir,
    sinceMs: sinceMs ?? null,
  });
}
