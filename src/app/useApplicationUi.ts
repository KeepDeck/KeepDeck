/**
 * The app's UI as the application controller reaches it: the close flow
 * with what the app carries a close out with, and the one binding that fills
 * the controller's UI port. A command an agent sends (`agent.close`,
 * `team.disband`, `agent.spawn`'s agent types) lands in the person's UI
 * through here, and nowhere else.
 */
import { useEffect, useRef } from "react";
import type { AgentInfo } from "../domain/agents";
import type { StatsTab } from "../domain/usage/statsTabs";
import { previewIntent } from "../ipc/lifecycle";
import type { ApplicationController } from "./applicationController";
import { askBackgroundCarriers } from "./liveSessions";
import type { AppRuntime } from "./runtime";
import { useCloseFlow } from "./useCloseFlow";
import type { Deck } from "./useDeck";

/** The close flow, carried out as the app carries it: the machine's
 * preview, the orchestrator's doors, the live registry's carriers. */
export function useAppCloseFlow(
  runtime: AppRuntime,
  deck: Deck,
  /** paneId → the missing directory, from the run view. */
  blockedPanes: Record<string, string>,
  pushAlert: (title: string, message: string) => void,
) {
  return useCloseFlow(deck, {
    onError: (message) => pushAlert("Can't close", message),
    onSuspendRefused: (message) => pushAlert("Can't suspend this agent", message),
    preview: previewIntent,
    blockedPanes,
    suspendAgent: runtime.orchestrator.suspend,
    closeAgents: runtime.orchestrator.close,
    // The registry ask the close sentence needs — batched (one query per
    // distinct agent), the same seam every live-session question goes
    // through, so the view layer never touches a plugin.
    backgroundCarriers: (entries) => askBackgroundCarriers(runtime.spawnPlugins, entries),
  });
}

/** What the app's UI does when its controller asks. */
export interface ApplicationUiParts {
  agents: AgentInfo[];
  openSettings(sectionId?: string): boolean;
  openStats(tab?: StatsTab | null): boolean;
  selectWeek(week: number | null): void;
  openTasks(taskId?: string | null): boolean;
  pushAlert(title: string, message: string): void;
  requestCloseAgent(wsId: string, paneId: string, label: string): void;
  requestDisbandTeam(wsId: string, teamId: string): void;
  setCreating(creating: boolean): void;
}

/** Bind the app's UI to its controller while the page is up. Each call
 * reads the parts of the latest render. */
export function useApplicationUiBinding(application: ApplicationController, parts: ApplicationUiParts): void {
  const latest = useRef(parts);
  latest.current = parts;
  useEffect(() => {
    const current = () => latest.current;
    return application.bindUi({
      agents: () => current().agents,
      requestCloseAgent: (wsId, paneId, label) => current().requestCloseAgent(wsId, paneId, label),
      requestDisbandTeam: (wsId, teamId) => current().requestDisbandTeam(wsId, teamId),
      openSettings: (sectionId) => current().openSettings(sectionId ?? undefined),
      openUsage: (tab, week) => {
        // A digest names the week it reports; Weekly opens on it.
        if (week !== undefined) current().selectWeek(week);
        return current().openStats(tab);
      },
      openTasks: (taskId) => current().openTasks(taskId),
      setCreating: (next) => current().setCreating(next),
      pushAlert: (title, message) => current().pushAlert(title, message),
    });
  }, [application]);
}
