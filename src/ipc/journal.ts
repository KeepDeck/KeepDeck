import { invoke } from "@tauri-apps/api/core";

/**
 * The workspace session journal's event log (`journal.jsonl`, [F8]). Lines
 * are opaque to the Rust side — the codec, folding and versioning live in
 * `src/domain/journal`; these commands only move bytes in the app config dir.
 */

/** Every line of the stored journal (empty on first run). */
export function loadJournal(): Promise<string[]> {
  return invoke<string[]>("journal_load");
}

/** Append encoded event lines (a single O_APPEND write, synced). */
export function appendJournal(lines: string[]): Promise<void> {
  return invoke("journal_append", { lines });
}

/** Rewrite the whole log (compaction) — atomic tmp+rename on the Rust side. */
export function compactJournal(lines: string[]): Promise<void> {
  return invoke("journal_compact", { lines });
}
