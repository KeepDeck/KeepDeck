/**
 * The application seam over the agents' live-session registries.
 *
 * Two surfaces ask the same question — a refused boot restore (the
 * deciding ask, before the binding's fate is settled) and the resume
 * picker (the advisory ask, when it opens). Both come through HERE so the
 * view layer never touches a plugin: the seam the session search already
 * uses, and the mistake step one of this work fixed.
 */
import type { LiveRegistryAnswer } from "../domain/agents";
import type { SpawnPluginAccess } from "./spawnSpecs";
import { findAgent } from "./spawnSpecs/plan";

/** Ask one agent's registry about ONE session.
 *
 * `null` is its own answer — the agent contributes no registry, so the
 * question was never asked and the caller must not read it as "absent".
 * A REFUSING registry (broken CLI, dead daemon, timeout) is "unknown":
 * the caller treats it like live, because erasing a binding on a failed
 * question is the harm this registry exists to prevent.
 */
export async function askLiveRegistry(
  plugins: SpawnPluginAccess,
  agentType: string,
  sessionId: string,
): Promise<LiveRegistryAnswer | null> {
  const live = findAgent(plugins, agentType)?.entry.liveSessions;
  if (!live) return null;
  try {
    const rows = await live.list();
    return rows.some((row) => row.sessionId === sessionId)
      ? "live"
      : "absent";
  } catch {
    return "unknown";
  }
}

/** The advisory ask for a picker: which of an agent's sessions are held
 * by outside processes right now. `ok: false` = the registry could not
 * answer — the picker marks rows "unknown" rather than blocking them
 * (they are NOT dead: a fork is legal immediately, a resume just gets
 * refused). */
export async function liveOutsideSessions(
  plugins: SpawnPluginAccess,
  agentType: string,
): Promise<{ ok: true; ids: ReadonlySet<string> } | { ok: false }> {
  const live = findAgent(plugins, agentType)?.entry.liveSessions;
  if (!live) return { ok: false };
  try {
    const rows = await live.list();
    return { ok: true, ids: new Set(rows.map((row) => row.sessionId)) };
  } catch {
    return { ok: false };
  }
}
