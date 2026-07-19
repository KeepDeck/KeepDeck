import { useEffect, useRef } from "react";
import type { AgentUsage, UsageLimitsSource } from "@keepdeck/plugin-api";
import { paneAgentType } from "../domain/deck";
import { log } from "../ipc/log";
import { fetchCodexRateLimits, fetchKimiUsages } from "../ipc/usage";
import { setAccountUsage } from "./usageManager";
import type { Deck } from "./useDeck";

/**
 * The polled-limits lane, for agents whose contribution declares
 * `limits.poll`: one boot fetch per source regardless of panes, then the
 * named NATIVE fetcher on a slow interval while one of that agent's panes
 * is LIVE, and never while the window is hidden. Failures just let the last
 * snapshot age into staleness. For codex, this cadence also supplies the
 * demand that keeps the shared app-server child warm; when polling stops,
 * its native manager reaps the child after the idle grace period.
 */

/** How often a declared limits source is re-fetched while its agent lives. */
export const LIMITS_POLL_MS = 60_000;

/** The native fetchers a `limits.poll` declaration may name. Named on
 * purpose: an arbitrary plugin URL with local credentials would be an
 * exfiltration hole, not flexibility. */
const LIMIT_SOURCES: Record<UsageLimitsSource, () => Promise<string>> = {
  "codex-app-server": fetchCodexRateLimits,
  "kimi-usages": fetchKimiUsages,
};

type LimitsRequest = () => Promise<void>;

interface RequestLane {
  running: boolean;
  /** At most one trailing refresh: bursts collapse to their latest request. */
  queued: LimitsRequest | null;
}

/** Serialize reads per provider. Boot/live and visibility triggers share this
 * lane, so response completion order can never invert request order. A trigger
 * that arrives in flight becomes one trailing refresh instead of disappearing. */
function enqueueLatest(
  lanes: Map<string, RequestLane>,
  provider: string,
  request: LimitsRequest,
): void {
  const lane = lanes.get(provider) ?? { running: false, queued: null };
  lanes.set(provider, lane);
  lane.queued = request;
  if (lane.running) return;

  const drain = () => {
    const next = lane.queued;
    if (!next) {
      lane.running = false;
      lanes.delete(provider);
      return;
    }
    lane.running = true;
    lane.queued = null;
    void next()
      .catch(() => {}) // each request already logs its provider-specific error
      .finally(drain);
  };
  drain();
}

export function useLimitsPolling(
  deck: Deck,
  usageByAgent: ReadonlyMap<string, AgentUsage>,
): void {
  const usageByAgentRef = useRef(usageByAgent);
  usageByAgentRef.current = usageByAgent;
  const requestLanesRef = useRef(new Map<string, RequestLane>());

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
  const polledAgentsRef = useRef(new Set<string>());
  polledAgentsRef.current = new Set(polledAgents ? polledAgents.split("\n") : []);

  const requestLimits = (
    agentId: string,
    phase: "boot fetch" | "poll",
    visibleLiveOnly: boolean,
  ) => {
    enqueueLatest(requestLanesRef.current, agentId, async () => {
      if (
        visibleLiveOnly &&
        (document.hidden || !polledAgentsRef.current.has(agentId))
      ) {
        return;
      }
      const limits = usageByAgentRef.current.get(agentId)?.limits;
      if (!limits) return;
      const requestedAt = Date.now();
      try {
        const body = await LIMIT_SOURCES[limits.poll]();
        // A plugin may have been replaced while native IO was in flight.
        if (usageByAgentRef.current.get(agentId)?.limits !== limits) return;
        const account = limits.normalize(body, requestedAt);
        if (account) setAccountUsage(agentId, account);
      } catch (e) {
        log.debug("web:usage", `${limits.poll} ${phase} failed: ${e}`);
      }
    });
  };

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
      requestLimits(agentId, "boot fetch", false);
    }
  }, [declaredKey, polledAgents]);

  useEffect(() => {
    if (!polledAgents) return;
    const timers: ReturnType<typeof setInterval>[] = [];
    const ticks: (() => void)[] = [];
    for (const agentId of polledAgents.split("\n")) {
      const tick = () => {
        // A hidden window keeps its panes but nobody is reading the chip —
        // don't spend the provider's request budget on it.
        if (document.hidden) return;
        requestLimits(agentId, "poll", true);
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
