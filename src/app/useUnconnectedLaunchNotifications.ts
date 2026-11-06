import { useEffect, useRef } from "react";
import type { AgentInfo } from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { initUnconnectedLaunchNotifications } from "./notificationProducers";
import { peekPaneSpawnSpec, subscribeSpawnSpecs } from "./spawnSpecs";

/**
 * Mount the launch → notification producer for panes whose agent runs
 * without KeepDeck's setup (task-572). One subscription per app, over the
 * plan cache; the deck facts a message needs are read through a ref at
 * announce time, the way [`useActivityNotifications`] reads them.
 */
export function useUnconnectedLaunchNotifications(
  workspaces: Workspace[],
  agents: AgentInfo[],
): void {
  const facts = useRef({ workspaces, agents });
  facts.current = { workspaces, agents };
  useEffect(
    () =>
      initUnconnectedLaunchNotifications(
        { subscribe: subscribeSpawnSpecs, peek: peekPaneSpawnSpec },
        () => facts.current,
      ),
    [],
  );
}
