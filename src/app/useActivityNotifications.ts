import { useEffect, useRef } from "react";
import type { AgentInfo } from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { initActivityNotifications } from "./notificationProducers";

/**
 * Mount the activity → notification producer. One subscription per app; the
 * deck facts a message needs (names change and panes close while the
 * subscription lives) are read through a ref at announce time, so the
 * composition root stays one line — the producer's internals are this
 * feature's, not the root's.
 */
export function useActivityNotifications(
  workspaces: Workspace[],
  agents: AgentInfo[],
): void {
  const facts = useRef({ workspaces, agents });
  facts.current = { workspaces, agents };
  useEffect(() => initActivityNotifications(() => facts.current), []);
}
