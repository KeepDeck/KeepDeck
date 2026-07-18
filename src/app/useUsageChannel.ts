import { useEffect, useMemo, useRef } from "react";
import type { AgentUsage, UsageLimitsSource } from "@keepdeck/plugin-api";
import { findWorkspaceOfPane, paneAgentType } from "../domain/deck";
import { log } from "../ipc/log";
import { onSessionBound } from "../ipc/sessions";
import {
  fetchKimiUsages,
  onUsageReport,
  unwatchRollout,
  watchRollout,
} from "../ipc/usage";
import {
  registerUsageNormalizer,
  reportUsage,
  retainUsagePanes,
  setAccountUsage,
} from "./usageManager";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { useAppRuntime } from "./runtimeContext";
import { useContributions } from "../plugins/react";
import { postbackAccepted } from "./useSessionBinding";
import type { Deck } from "./useDeck";

/**
 * The single mount point wiring usage into the store — one subscription per
 * app (the store is a singleton; `useUsage` readers mount freely, this hook
 * must not). What flows where is DECLARED by each CLI plugin's `usage`
 * contribution; this hook only executes the declarations:
 *
 * - `normalize` registers into the store per agent id — the plugin owns its
 *   payload schema.
 * - `tail` arms the native session-file tailer when that agent's binding
 *   carries a transcript path (rebinds replace the tail).
 * - `limits.poll` runs the named native fetcher on a slow interval while
 *   one of that agent's panes is LIVE (kimi keeps its short-lived token
 *   fresh only during activity; polling an idle machine would only 401).
 *
 * Verification mirrors the session binding: a report counts only when it
 * echoes the secret the pane's own spawn carried. The retain effect prunes
 * pane usage AND tails as panes close; account chips deliberately survive
 * their reporter.
 */

/** How often a declared limits source is re-fetched while its agent lives. */
export const LIMITS_POLL_MS = 60_000;

/** The native fetchers a `limits.poll` declaration may name. */
const LIMIT_SOURCES: Record<UsageLimitsSource, () => Promise<string>> = {
  "kimi-usages": fetchKimiUsages,
};

export function useUsageChannel(deck: Deck): void {
  const deckRef = useRef(deck);
  deckRef.current = deck;
  // Panes with a live session-file tail — the retain sweep's unwatch list.
  const tailedRef = useRef(new Set<string>());

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
  const usageByAgentRef = useRef(usageByAgent);
  usageByAgentRef.current = usageByAgent;

  // Plugin normalizers → store registrations, in lockstep with activation.
  useEffect(() => {
    const disposers = [...usageByAgent].map(([id, usage]) =>
      registerUsageNormalizer(id, usage.normalize),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [usageByAgent]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const subscribe = (start: Promise<() => void>) =>
      void start.then((u) => {
        if (disposed) u();
        else unlisteners.push(u);
      });

    subscribe(
      onUsageReport(({ paneId, token, payload }) => {
        if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) {
          log.warn(
            "web:bridge",
            `usage report for ${paneId} with a wrong token — ignored`,
          );
          return;
        }
        reportUsage(paneId, payload);
      }),
    );

    subscribe(
      onSessionBound(({ paneId, token, transcriptPath }) => {
        if (!transcriptPath) return;
        if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) return;
        const ws = findWorkspaceOfPane(deckRef.current.workspaces, paneId);
        const pane = ws?.panes.find((p) => p.id === paneId);
        if (!pane) return;
        const format = usageByAgentRef.current.get(paneAgentType(pane))?.tail;
        if (!format) return;
        tailedRef.current.add(paneId);
        watchRollout(paneId, transcriptPath, token, format).catch((e) =>
          log.warn("web:usage", `session-file tail for ${paneId} failed: ${e}`),
        );
      }),
    );

    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // A string key so the retain sweep runs only when pane MEMBERSHIP changes,
  // not on every deck render.
  const paneIds = deck.workspaces
    .flatMap((ws) => ws.panes.map((pane) => pane.id))
    .sort()
    .join("\n");
  useEffect(() => {
    const live = new Set(paneIds.split("\n").filter(Boolean));
    retainUsagePanes(live);
    for (const paneId of [...tailedRef.current]) {
      if (live.has(paneId)) continue;
      tailedRef.current.delete(paneId);
      void unwatchRollout(paneId);
    }
  }, [paneIds]);

  // Declared limits polls, gated per agent on a LIVE (non-dormant) pane.
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
      const tick = () =>
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
      tick();
      timers.push(setInterval(tick, LIMITS_POLL_MS));
    }
    return () => {
      for (const timer of timers) clearInterval(timer);
    };
  }, [polledAgents]);
}
