import { useEffect, useRef } from "react";
import { paneAgentType } from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { getUsageSnapshot, subscribeUsage } from "./usageManager";
import { recordPaneUsage } from "./usageHistoryManager";
import {
  peekPaneSpawnSpec,
  spawnPlanNeedsUsageBaseline,
} from "./spawnSpecs";
import type { Deck } from "./useDeck";

/** Capture live cumulative pane snapshots into the durable delta log. Deck
 * context supplies stable session/workspace/worktree attribution that plugin
 * payloads should not know about. Unbound reports wait for the next update —
 * guessing a session key would merge unrelated fresh runs. */
export function useUsageHistory(deck: Deck): void {
  const deckRef = useRef(deck);
  deckRef.current = deck;

  useEffect(() => {
    const capture = () => {
      const current = deckRef.current;
      for (const [paneId, usage] of getUsageSnapshot().panes) {
        const workspace = current.workspaces.find((candidate) =>
          candidate.panes.some((pane) => pane.id === paneId),
        );
        const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
        if (!workspace || !pane || paneAgentType(pane) !== usage.agent) continue;
        const sessionId = usage.sessionId ?? pane.session?.id;
        if (!sessionId) continue;
        const baselineOnly = spawnPlanNeedsUsageBaseline(
          peekPaneSpawnSpec(paneId),
          sessionId,
        );
        const index = workspace.panes.indexOf(pane);
        void recordPaneUsage(usage, {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceCwd: workspace.cwd,
          paneId,
          paneName: pane.name ?? pane.autoTitle ?? `Agent ${index + 1}`,
          sessionId,
          ...(baselineOnly ? { baselineOnly: true } : {}),
          ...(pane.cwd
            ? {
                worktree: {
                  path: pane.cwd,
                  repo: workspace.cwd,
                  ...(pane.branch ? { branch: pane.branch } : {}),
                },
              }
            : {}),
        }).catch((error) =>
          log.warn(
            "web:usage",
            `usage history append failed: ${describeError(error)}`,
          ),
        );
      }
    };
    capture();
    return subscribeUsage(capture);
  }, []);
}
