import { useEffect, useState } from "react";
import type { AgentInfo } from "../domain/agents";
import { listAgents } from "../ipc/agents";

/** Load the agent catalog into component state. Fetches per mount, so re-opening
 *  a spawn form re-detects (a just-installed agent shows up without a restart). */
export function useAgents(): { agents: AgentInfo[]; loading: boolean } {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    listAgents().then((a) => {
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
