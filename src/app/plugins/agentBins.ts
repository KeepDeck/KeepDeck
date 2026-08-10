/**
 * What the host knows about the agent CLIs on this machine.
 *
 * Two facts per binary, asked SEPARATELY because they cost three orders of
 * magnitude apart. Whether it is installed is a PATH lookup — microseconds,
 * needed by the activation gate and the agent picker, so it is asked for
 * everything at boot. What it answers to `--version` is a program RUN —
 * about half a second each — and it is read by exactly one thing: a plugin
 * deciding which of its CLI's wire formats to speak (codex replaced its
 * hook-output schema between 0.146 and 0.147).
 *
 * They were briefly one call, and every boot paid ~1.9s of blocked main
 * thread for a fact most users never read: the version is only consulted
 * while rendering teammate mail, which needs a running pane and a feature
 * that is off by default. So versions are asked LAZILY — once, when a pane
 * with that agent starts — and remembered.
 *
 * Its own module because it is the one thing here that is ABOUT the machine
 * rather than about the plugin set. Everything here is keyed by BINARY; the
 * walk from an agent id to the bin it declared is a fact about the plugin
 * registry, and lives with it (`binOfAgent`, in the plugin manager).
 */
import { detectBins, probeVersion } from "../../ipc/agents";

export interface AgentBins {
  /** Whether a bin is installed. Absent entries read as installed —
   * permissive by design: a detection that never ran must not gate. */
  installed(bin: string): boolean;
  /** What this bin answered to `--version`, or null when it has not been
   * asked or could not answer. Synchronous, because its one caller renders a
   * hook reply inside a turn boundary and cannot wait. Null means "assume
   * the current schema", which is what every consumer already does. */
  version(bin: string): string | null;
  /** Detect the given bins once and record whether they are installed.
   * Nothing is executed. */
  detect(bins: string[]): Promise<void>;
  /** Ask this bin its version if nobody has yet, and remember the answer.
   *
   * Single-flight per bin: two panes starting together ask once. Remembered
   * until `detect` runs over that bin again — which is the Rescan and the
   * enable gesture, the two moments a CLI on this machine can have changed
   * under a running app.
   *
   * The CALLER establishes that this bin may be run. Nothing here knows
   * about capabilities. */
  ensureVersion(bin: string): Promise<void>;
}

export function createAgentBins(
  probe: (bins: string[]) => Promise<
    { bin: string; installed: boolean }[]
  > = detectBins,
  askVersion: (bin: string) => Promise<string | null> = probeVersion,
): AgentBins {
  /** NOTE there is a second bin-status cache in `useAgents` (per-mount, for
   * the agent pickers); this one is the ACTIVATION gate's — refreshed at
   * bootstrap, rescan and enable gestures. New consumers should pick
   * deliberately: picker/live freshness → useAgents, lifecycle gating →
   * here. */
  const installed = new Map<string, boolean>();
  const version = new Map<string, string | null>();
  /** Asks in flight, so a bin is never probed twice at once. */
  const asking = new Map<string, Promise<void>>();

  return {
    installed: (bin) => installed.get(bin) !== false,
    version: (bin) => version.get(bin) ?? null,
    async detect(bins) {
      for (const bin of bins) {
        // A re-detection is the app asking again what is on this machine —
        // Rescan, or an enable gesture — which is exactly when a CLI may have
        // been upgraded under it. Forgetting the version makes the next
        // asker re-ask; keeping it made the cache write-once for the life of
        // the process, so a codex upgraded from 0.146 to 0.147 mid-session
        // went on being answered in a schema it no longer speaks.
        version.delete(bin);
      }
      for (const status of await probe(bins)) {
        installed.set(status.bin, status.installed);
      }
    },
    ensureVersion(bin) {
      if (version.has(bin)) return Promise.resolve();
      const already = asking.get(bin);
      if (already) return already;
      // Recorded even when it comes back null: "asked and could not tell" is
      // an answer, and re-asking on every pane start would spend half a
      // second each time to learn the same nothing.
      const work = askVersion(bin)
        .then((answer) => {
          version.set(bin, answer);
        })
        .finally(() => asking.delete(bin));
      asking.set(bin, work);
      return work;
    },
  };
}
