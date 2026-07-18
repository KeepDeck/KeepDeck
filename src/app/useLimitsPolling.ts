import { useEffect, useRef } from "react";
import type { AgentUsage, UsageLimitsSource } from "@keepdeck/plugin-api";
import { paneAgentType } from "../domain/deck";
import { log } from "../ipc/log";
import { fetchKimiUsages } from "../ipc/usage";
import { setAccountUsage } from "./usageManager";
import type { Deck } from "./useDeck";

/**
 * The polled-limits lane, for agents whose contribution declares
 * `limits.poll`: the named NATIVE fetcher runs on a slow interval while
 * one of that agent's panes is LIVE (kimi keeps its short-lived token
 * fresh only during activity — polling an idle machine would only 401),
 * and never while the window is hidden. Failures just let the last
 * snapshot age into staleness.
 */

/** How often a declared limits source is re-fetched while its agent lives. */
export const LIMITS_POLL_MS = 60_000;

/** The native fetchers a `limits.poll` declaration may name. Named on
 * purpose: an arbitrary plugin URL with local credentials would be an
 * exfiltration hole, not flexibility. */
const LIMIT_SOURCES: Record<UsageLimitsSource, () => Promise<string>> = {
  "kimi-usages": fetchKimiUsages,
};

export function useLimitsPolling(
  deck: Deck,
  usageByAgent: ReadonlyMap<string, AgentUsage>,
): void {
  const usageByAgentRef = useRef(usageByAgent);
  usageByAgentRef.current = usageByAgent;

  const polledAgents = [...usageByAgent]
    .filter(([, usage]) => usage.limits)
    .map(([id]) => id)
    .filter((id) =>
      deck.workspaces.some((ws) =>
        ws.panes.some((p) => paneAgentType(p) === id && !p.dormant),
      ),
    )
    .sort()
    .join("\n");
  useEffect(() => {
    if (!polledAgents) return;
    const timers: ReturnType<typeof setInterval>[] = [];
    for (const agentId of polledAgents.split("\n")) {
      const limits = usageByAgentRef.current.get(agentId)?.limits;
      if (!limits) continue;
      const fetch = LIMIT_SOURCES[limits.poll];
      const tick = () => {
        // A hidden window keeps its panes but nobody is reading the chip —
        // don't spend the provider's request budget on it.
        if (document.hidden) return;
        void fetch()
          .then((body) => {
            const account = limits.normalize(body, Date.now());
            if (account) setAccountUsage(agentId, account);
          })
          // Expected while the CLI is idle (short-lived tokens 401) — the
          // last snapshot simply ages into staleness.
          .catch((e) =>
            log.debug("web:usage", `${limits.poll} poll failed: ${e}`),
          );
      };
      tick();
      timers.push(setInterval(tick, LIMITS_POLL_MS));
    }
    return () => {
      for (const timer of timers) clearInterval(timer);
    };
  }, [polledAgents]);
}
