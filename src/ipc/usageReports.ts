import { invoke } from "@tauri-apps/api/core";

/** Native persistence for the provider window-report journal. Lines are
 * opaque to Rust; the domain codec (reportJournal.ts) owns schema and
 * tolerant recovery. */
export function loadUsageReports(): Promise<string[]> {
  return invoke<string[]>("usage_reports_load");
}

/** Append as one ordered, fsynced write. */
export function appendUsageReports(lines: string[]): Promise<void> {
  return invoke("usage_reports_append", { lines });
}

/** Atomic retention rewrite. */
export function compactUsageReports(lines: string[]): Promise<void> {
  return invoke("usage_reports_compact", { lines });
}
