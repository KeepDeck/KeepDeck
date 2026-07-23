import { useEffect, useMemo, useState } from "react";
import type { AgentContribution } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../domain/agents";
import { detectBins, type BinStatus } from "../ipc/agents";
import { useContributions } from "../plugins/react";
import { useAppRuntime } from "./runtimeContext";

// Last known per-bin install status. A remount seeds from it so consumers
// never render a "nothing installed" flash while re-detection runs; detection
// re-runs per mount, so a just-installed agent shows up without a restart.
let lastStatus = new Map<string, BinStatus>();

/**
 * The agent catalog: agents contributed by cli plugins, annotated with
 * install detection. The registry fills as plugins activate — `loading` is
 * plugin bootstrap, not detection, so an empty catalog AFTER boot is an
 * honest empty (every cli plugin disabled), not a fallback moment. Until a
 * bin's status arrives it counts as installed: better to offer an agent that
 * may fail to spawn than to hide one that works.
 */
export function useAgents(): { agents: AgentInfo[]; loading: boolean } {
  const { bootstrapPlugins, pluginRegistries } = useAppRuntime().plugins;
  const contributions = useContributions(pluginRegistries.agents);
  const [booted, setBooted] = useState(false);
  const [status, setStatus] = useState(lastStatus);

  useEffect(() => {
    let alive = true;
    // Idempotent join on the app's one bootstrap — App kicked it off at
    // mount; this only observes completion.
    void bootstrapPlugins().then(() => {
      if (alive) setBooted(true);
    });
    return () => {
      alive = false;
    };
  }, [bootstrapPlugins]);

  const binsKey = useMemo(
    () =>
      [...new Set(contributions.map((c) => c.entry.detect.bin))]
        .sort()
        .join("\n"),
    [contributions],
  );
  useEffect(() => {
    if (!binsKey) return;
    let alive = true;
    void detectBins(binsKey.split("\n")).then((statuses) => {
      const next = new Map(lastStatus);
      for (const s of statuses) next.set(s.bin, s);
      lastStatus = next;
      if (alive) setStatus(next);
    });
    return () => {
      alive = false;
    };
  }, [binsKey]);

  const agents = useMemo(
    () =>
      contributions.map(({ entry }) =>
        toAgentInfo(entry, status.get(entry.detect.bin)),
      ),
    [contributions, status],
  );
  return { agents, loading: !booted };
}

function toAgentInfo(
  entry: AgentContribution,
  status: BinStatus | undefined,
): AgentInfo {
  return {
    id: entry.id,
    label: entry.label,
    icon: entry.icon,
    command: entry.detect.bin,
    supportsYolo: entry.supportsYolo === true,
    supportsRemote: entry.remote?.mode === "nativeServer",
    installed: status?.installed ?? true,
    path: status?.path ?? null,
    usageCapabilities: entry.usage?.capabilities ?? [],
  };
}

/** Test hook: forget the cached detection. */
export function resetAgentsCache(): void {
  lastStatus = new Map();
}
