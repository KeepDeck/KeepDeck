import { invoke } from "@tauri-apps/api/core";

/**
 * The week the weekly digest last reported — a cache document like the
 * congratulated achievements: the webview owns the schema and reads
 * tolerantly; the worst a bad file causes is one repeated digest.
 */

export function loadDigest(): Promise<string | null> {
  return invoke<string | null>("digest_load");
}

export function saveDigest(json: string): Promise<void> {
  return invoke("digest_save", { json });
}
