/**
 * What the host knows about the agent CLIs on this machine.
 *
 * Two facts per binary, filled by one detection pass: whether it is installed
 * — the activation gate's source of truth — and what it answers to
 * `--version`, because a CLI's wire protocols move between releases (codex
 * replaced its whole hook-output schema between 0.146 and 0.147) and a plugin
 * that has to speak the right one has nothing else to go on.
 *
 * Its own module because it is the one thing here that is ABOUT the machine
 * rather than about the plugin set, and because the version half arrived as a
 * mail concern grafted onto a file that already held eight responsibilities.
 * The join from an agent id to its bin lives here too, so no caller repeats
 * the walk from a registry entry to `detect.bin` to this cache.
 */
import { detectBins } from "../../ipc/agents";

export interface AgentBins {
  /** Whether a bin is installed. Absent entries read as installed —
   * permissive by design: a detection that never ran must not gate. */
  installed(bin: string): boolean;
  /** What this bin answered to `--version`, or null. Null means "could not
   * tell", which every consumer must read as "assume the current schema",
   * never as "old". */
  version(bin: string): string | null;
  /** Detect the given bins once and record what came back. Shared by the
   * bootstrap pass (every declared bin) and the enable gesture's refresh. */
  detect(bins: string[]): Promise<void>;
}

export function createAgentBins(
  probe: (bins: string[]) => Promise<
    { bin: string; installed: boolean; version?: string | null }[]
  > = detectBins,
): AgentBins {
  /** NOTE there is a second bin-status cache in `useAgents` (per-mount, for
   * the agent pickers); this one is the ACTIVATION gate's — refreshed at
   * bootstrap, rescan and enable gestures. New consumers should pick
   * deliberately: picker/live freshness → useAgents, lifecycle gating →
   * here. */
  const installed = new Map<string, boolean>();
  const version = new Map<string, string>();
  return {
    installed: (bin) => installed.get(bin) !== false,
    version: (bin) => version.get(bin) ?? null,
    async detect(bins) {
      for (const status of await probe(bins)) {
        installed.set(status.bin, status.installed);
        if (status.version) version.set(status.bin, status.version);
      }
    },
  };
}
