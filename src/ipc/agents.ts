import { invoke } from "@tauri-apps/api/core";
import { describeError, log } from "./log";

/** Install status of one binary name (mirrors the Rust `BinStatusDto`). */
export interface BinStatus {
  bin: string;
  installed: boolean;
  path: string | null;
  /** What it answers to `--version`, when that is legible. Null means "could
   * not tell", never "old" — see the Rust side for why a plugin needs it. */
  version: string | null;
}

/** Detect which of the requested binaries resolve on the spawn PATH — the
 *  generic detection agent plugins' declared `detect.bin` goes through.
 *  Degrades to "all installed" if the backend errors: better to offer an
 *  agent that may fail to spawn than to hide one that works.
 *
 *  `probe` names the subset whose `--version` may be READ, which means run.
 *  Presence is a lookup and free for everyone; execution is the caller's
 *  capability decision, so a caller that only needs "is it there" omits it
 *  and nothing is spawned. */
export async function detectBins(
  bins: string[],
  probe: string[] = [],
): Promise<BinStatus[]> {
  if (bins.length === 0) return [];
  try {
    return await invoke<BinStatus[]>("agents_detect", { bins, probe });
  } catch (e) {
    log.warn("web:agents", `agents_detect failed; assuming installed: ${describeError(e)}`);
    return bins.map((bin) => ({ bin, installed: true, path: null, version: null }));
  }
}
