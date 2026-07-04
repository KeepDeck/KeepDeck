import { useEffect, useState } from "react";
import type { AgentInfo } from "../domain/agents";
import { listAgents } from "../ipc/agents";

// The last successfully fetched catalog. A remount seeds from it so consumers
// never render an empty picker while re-detection runs — App's boot mount
// warms it long before any dialog opens.
let lastCatalog: AgentInfo[] | null = null;

/** Load the agent catalog into component state. Fetches per mount, so re-opening
 *  a spawn form re-detects (a just-installed agent shows up without a restart);
 *  until the fetch returns, the previous catalog stands in. */
export function useAgents(): { agents: AgentInfo[]; loading: boolean } {
  const [agents, setAgents] = useState<AgentInfo[]>(lastCatalog ?? []);
  const [loading, setLoading] = useState(lastCatalog === null);
  useEffect(() => {
    let alive = true;
    listAgents().then((a) => {
      lastCatalog = a;
      if (!alive) return;
      setAgents(a);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { agents, loading };
}

/** Test hook: forget the cached catalog. */
export function resetAgentsCache(): void {
  lastCatalog = null;
}
