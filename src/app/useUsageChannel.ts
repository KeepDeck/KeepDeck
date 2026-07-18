import { useMemo } from "react";
import type { AgentUsage } from "@keepdeck/plugin-api";
import { useAppRuntime } from "./runtimeContext";
import { useContributions } from "../plugins/react";
import { useLimitsPolling } from "./useLimitsPolling";
import { useUsageBootSweep } from "./useUsageBootSweep";
import { useUsageNormalizers } from "./useUsageNormalizers";
import { useUsageReports } from "./useUsageReports";
import { useUsageRetention } from "./useUsageRetention";
import { useUsageTails } from "./useUsageTails";
import type { Deck } from "./useDeck";

/**
 * The single mount point wiring usage into the store — one subscription per
 * app (the store is a singleton; `useUsage` readers mount freely, this hook
 * must not). What flows where is DECLARED by each CLI plugin's `usage`
 * contribution; this composer only distributes the declarations to the
 * single-purpose lanes:
 *
 * - [`useUsageNormalizers`] — plugin normalize fns ⇄ store registrations;
 * - [`useUsageReports`]     — bridge reports, token-verified, into the store;
 * - [`useUsageTails`]       — declared session-file tails (binding-armed,
 *                             codex TUI-resume fallback, close GC);
 * - [`useLimitsPolling`]    — declared polled limit sources (plus their
 *                             one-shot boot fetch);
 * - [`useUsageBootSweep`]   — the newest on-disk codex rollout at boot;
 * - [`useUsageRetention`]   — store hygiene as panes close.
 *
 * Snapshot persistence is deliberately NOT a lane: it consumes nothing
 * reactive, so it boots from `main.tsx` (`initUsagePersistence`) beside
 * `initSettings`, the store-persistence idiom.
 */
export function useUsageChannel(deck: Deck): void {
  const { plugins } = useAppRuntime();
  const contributions = useContributions(plugins.pluginRegistries.agents);
  /** agent id → its usage declaration, rebuilt as plugins (de)activate. */
  const usageByAgent = useMemo(() => {
    const map = new Map<string, AgentUsage>();
    for (const { entry } of contributions) {
      if (entry.usage) map.set(entry.id, entry.usage);
    }
    return map;
  }, [contributions]);

  useUsageNormalizers(usageByAgent);
  useUsageReports();
  useUsageTails(deck, usageByAgent);
  useLimitsPolling(deck, usageByAgent);
  useUsageBootSweep(usageByAgent);
  useUsageRetention(deck);
}
