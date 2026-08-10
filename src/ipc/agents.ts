import { invoke } from "@tauri-apps/api/core";
import { describeError, log } from "./log";

/** Install status of one binary name (mirrors the Rust `BinStatusDto`). */
export interface BinStatus {
  bin: string;
  installed: boolean;
  path: string | null;
}

/** Detect which of the requested binaries resolve on the spawn PATH — the
 *  generic detection agent plugins' declared `detect.bin` goes through.
 *  Degrades to "all installed" if the backend errors: better to offer an
 *  agent that may fail to spawn than to hide one that works.
 *
 *  Presence only, and nothing is executed. What a binary ANSWERS is a
 *  separate call with a separate price — see [`probeVersion`]. */
export async function detectBins(bins: string[]): Promise<BinStatus[]> {
  if (bins.length === 0) return [];
  try {
    return await invoke<BinStatus[]>("agents_detect", { bins });
  } catch (e) {
    log.warn("web:agents", `agents_detect failed; assuming installed: ${describeError(e)}`);
    return bins.map((bin) => ({ bin, installed: true, path: null }));
  }
}

/**
 * What `bin` answers to `--version`, or null when it could not be asked.
 *
 * RUNS the binary, so the caller must have established that it may — the
 * `exec` capability of the plugin that declared it. It costs about half a
 * second, which is why it is not folded into detection: everyone needs
 * presence at boot, and almost nobody reads a version at all.
 *
 * Null on failure like everything on this path. Every consumer already reads
 * null as "assume the current protocol", never as "old".
 */
export async function probeVersion(bin: string): Promise<string | null> {
  try {
    return (await invoke<string | null>("agents_probe_version", { bin })) ?? null;
  } catch (e) {
    log.warn("web:agents", `probing ${bin} --version failed: ${describeError(e)}`);
    return null;
  }
}
