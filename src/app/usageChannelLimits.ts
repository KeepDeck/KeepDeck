import type { UsageLimitsSource } from "@keepdeck/plugin-api";
import { paneAgentType, paneHasProcess } from "../domain/deck";
import { log } from "../ipc/log";
import { fetchCodexRateLimits, fetchKimiUsages } from "../ipc/usage";
import { setAccountUsage } from "./usageManager";
import { usageSourceTimestamp } from "./usageProvenance";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";

export const LIMITS_POLL_MS = 60_000;

interface LimitsRead {
  body: string;
  sourceAt?: number;
}

const LIMIT_SOURCES: Record<UsageLimitsSource, () => Promise<LimitsRead>> = {
  "codex-app-server": fetchCodexRateLimits,
  "kimi-usages": async () => ({ body: await fetchKimiUsages() }),
};

type LimitsRequest = () => Promise<void>;

interface RequestLane {
  running: boolean;
  queued: LimitsRequest | null;
}

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
    void next().catch(() => {}).finally(drain);
  };
  drain();
}

/** Declared account-limit boot reads and live-pane polling. */
export function createUsageLimitsLane({
  deck,
  declarations,
}: UsageLaneContext): UsageLane {
  let disposed = false;
  let polledKey = "";
  let polledAgents = new Set<string>();
  const booted = new Set<string>();
  const requestLanes = new Map<string, RequestLane>();
  let timers: ReturnType<typeof setInterval>[] = [];

  const requestLimits = (
    agentId: string,
    phase: "boot fetch" | "poll",
    visibleLiveOnly: boolean,
  ) => {
    enqueueLatest(requestLanes, agentId, async () => {
      if (disposed) return;
      if (
        visibleLiveOnly &&
        (document.hidden || !polledAgents.has(agentId))
      ) {
        return;
      }
      const limits = declarations.current().get(agentId)?.limits;
      if (!limits) return;
      const requestedAt = Date.now();
      try {
        const read = await LIMIT_SOURCES[limits.poll]();
        if (
          disposed ||
          declarations.current().get(agentId)?.limits !== limits
        ) {
          return;
        }
        const sourceAt =
          usageSourceTimestamp(read.sourceAt, Date.now()) ?? requestedAt;
        const account = limits.normalize(read.body, sourceAt);
        if (account) setAccountUsage(agentId, account);
      } catch (error) {
        log.debug("web:usage", `${limits.poll} ${phase} failed: ${error}`);
      }
    });
  };

  const tick = (agentId: string) => {
    if (document.hidden) return;
    requestLimits(agentId, "poll", true);
  };

  const resetPolling = (nextKey: string) => {
    for (const timer of timers) globalThis.clearInterval(timer);
    timers = [];
    polledKey = nextKey;
    if (!nextKey) return;
    for (const agentId of nextKey.split("\n")) {
      tick(agentId);
      timers.push(
        globalThis.setInterval(
          () => tick(agentId),
          LIMITS_POLL_MS,
        ),
      );
    }
  };

  const reconcile = () => {
    if (disposed) return;
    const usage = declarations.current();
    const declared = [...usage]
      .filter(([, declaration]) => declaration.limits)
      .map(([agentId]) => agentId)
      .sort();
    const workspaces = deck.getSnapshot().workspaces;
    const nextPolled = declared.filter((agentId) =>
      workspaces.some((workspace) =>
        workspace.panes.some(
          (pane) =>
            paneAgentType(pane) === agentId && paneHasProcess(pane),
        ),
      ),
    );
    polledAgents = new Set(nextPolled);

    for (const agentId of declared) {
      if (booted.has(agentId)) continue;
      booted.add(agentId);
      if (!polledAgents.has(agentId)) {
        requestLimits(agentId, "boot fetch", false);
      }
    }

    const nextKey = nextPolled.join("\n");
    if (nextKey !== polledKey) resetPolling(nextKey);
  };

  const onVisible = () => {
    if (document.hidden) return;
    for (const agentId of polledAgents) tick(agentId);
  };

  const unsubscribeDeck = deck.subscribe(reconcile);
  const unsubscribeDeclarations = declarations.subscribe(reconcile);
  document.addEventListener("visibilitychange", onVisible);
  reconcile();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeDeck();
      unsubscribeDeclarations();
      document.removeEventListener("visibilitychange", onVisible);
      for (const timer of timers) globalThis.clearInterval(timer);
      timers = [];
      for (const lane of requestLanes.values()) lane.queued = null;
    },
  };
}
