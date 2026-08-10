/**
 * Which agent's binary the host may ASK for its version — the one rule that
 * stands between a manifest field and a process being started.
 *
 * Pure, and its own module, because it is the security-relevant half of a
 * lazy probe and it used to live somewhere no test could reach: the check
 * was an inline condition inside the plugin manager's factory, and the only
 * test that had ever bound it was in the host, guarding a shape that no
 * longer exists.
 *
 * The rule has two halves, and both matter:
 *
 *  - the bin comes from the agent CONTRIBUTION, because that is what a pane
 *    actually spawns;
 *  - the permission comes from the OWNING plugin's manifest, because that is
 *    what the user consented to. Asking the union of every installed
 *    plugin's `exec` list would let a plugin ride on somebody else's
 *    consent.
 *
 * So a plugin that registers an agent whose bin its own manifest never
 * declared gets presence and nothing more, and one that declared it without
 * an `exec` capability gets the same.
 */
import { probeableAgentBins, type PluginManifest } from "@keepdeck/plugin-api";

/** One agent as the registry holds it: who contributed it, and what it runs. */
export interface ContributedAgent {
  pluginId: string;
  entry: { id: string; detect: { bin: string } };
}

/** What a plugin manifest looks like from here. */
export interface OwnedManifest {
  manifest: PluginManifest;
}

/**
 * What this agent RUNS, or null when the registry does not hold it.
 *
 * The walk from an agent id to its declared bin, written once: everything in
 * `agentBins` is keyed by binary, and a caller doing this itself would be a
 * second place that knows where `detect.bin` lives.
 */
export function binOfAgent(
  agents: readonly ContributedAgent[],
  agentId: string,
): string | null {
  return (
    agents.find((agent) => agent.entry.id === agentId)?.entry.detect.bin ?? null
  );
}

/**
 * The binary this agent may be probed through, or null when it may not be.
 *
 * Null covers every reason at once and deliberately says nothing about
 * which: an unknown agent, a plugin uninstalled since it registered, a bin
 * no `exec` capability covers. The caller does the same thing in all of
 * them — nothing.
 */
export function probeableBinOfAgent(
  agents: readonly ContributedAgent[],
  installed: readonly OwnedManifest[],
  agentId: string,
): string | null {
  // First contribution wins, the same way the registry itself resolves an
  // agent id — and the bin and the owner are read from that SAME entry, so
  // a bin can never be paired with another plugin's permissions.
  const contributed = agents.find((agent) => agent.entry.id === agentId);
  const bin = contributed?.entry.detect.bin;
  if (!contributed || !bin) return null;
  const owner = installed.find(
    (plugin) => plugin.manifest.id === contributed.pluginId,
  );
  if (!owner) return null;
  return probeableAgentBins(owner.manifest).includes(bin) ? bin : null;
}
