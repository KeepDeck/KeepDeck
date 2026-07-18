import { useEffect, useRef } from "react";
import type { AgentUsage, UsageLimitsSource } from "@keepdeck/plugin-api";
import { paneAgentType } from "../domain/deck";
import { log } from "../ipc/log";
import { fetchKimiUsages } from "../ipc/usage";
import { setAccountUsage } from "./usageManager";
import type { Deck } from "./useDeck";

/**
 * The polled-limits lane, for agents whose contribution declares
 * `limits.poll`: one boot fetch per source regardless of panes, then the
 * named NATIVE fetcher on a slow interval while one of that agent's panes
 * is LIVE (kimi keeps its short-lived token fresh only during activity —
 * polling an idle machine would only 401), and never while the window is
 * hidden. Failures just let the last snapshot age into staleness.
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

  const declaredAgents = [...usageByAgent]
    .filter(([, usage]) => usage.limits)
    .map(([id]) => id)
    .sort();
  const polledAgents = declaredAgents
    .filter((id) =>
      deck.workspaces.some((ws) =>
        ws.panes.some((p) => paneAgentType(p) === id && !p.dormant),
      ),
    )
    .join("\n");

  // The boot fetch: once per declared source per app run, pane or no pane —
  // the chip should be current the moment the window first shows, not after
  // the user happens to open that agent. Agents with a live pane at boot
  // are left to the polling lane below (its own immediate tick covers
  // them); a source that 401s while its CLI is idle just stays on the aged
  // snapshot, exactly like a failed poll.
  const bootedRef = useRef(new Set<string>());
  const declaredKey = declaredAgents.join("\n");
  useEffect(() => {
    const polling = new Set(polledAgents ? polledAgents.split("\n") : []);
    for (const agentId of declaredKey ? declaredKey.split("\n") : []) {
      if (bootedRef.current.has(agentId)) continue;
      bootedRef.current.add(agentId);
      if (polling.has(agentId)) continue;
      const limits = usageByAgentRef.current.get(agentId)?.limits;
      if (!limits) continue;
      void LIMIT_SOURCES[limits.poll]()
        .then((body) => {
          const account = limits.normalize(body, Date.now());
          if (account) setAccountUsage(agentId, account);
        })
        .catch((e) =>
          log.debug("web:usage", `${limits.poll} boot fetch failed: ${e}`),
        );
    }
  }, [declaredKey, polledAgents]);

  useEffect(() => {
    if (!polledAgents) return;
    const timers: ReturnType<typeof setInterval>[] = [];
    const ticks: (() => void)[] = [];
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
      ticks.push(tick);
      timers.push(setInterval(tick, LIMITS_POLL_MS));
    }
    // Un-hiding shouldn't wait out the rest of an interval with a stale
    // chip — refresh the moment the window is visible again.
    const onVisible = () => {
      if (!document.hidden) for (const tick of ticks) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      for (const timer of timers) clearInterval(timer);
    };
  }, [polledAgents]);
}
