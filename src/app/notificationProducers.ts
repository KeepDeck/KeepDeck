import {
  findWorkspace,
  paneDisplayTitle,
  type Workspace,
} from "../domain/deck";
import type { AgentInfo } from "../domain/agents";
import type { NotificationSource } from "../domain/notifications";
import { DEFAULT_SETTINGS } from "../domain/settings";
import { notify } from "./notificationCenter";
import { getSettings } from "./settingsManager";
import { getUpdateState, subscribeUpdates } from "./updateManager";

/**
 * The built-in notification producers — thin adapters that turn moments the
 * app already observes into [`notify`] calls. Pane-scoped ones are invoked
 * from the composition root (it holds the deck state that names workspaces
 * and panes); the update producer subscribes to `updateManager` at boot.
 */

function paneContext(
  workspaces: Workspace[],
  wsId: string,
  paneId: string,
  agents: AgentInfo[],
): {
  title: string;
  wsName: string;
  workspace: { id: string; instance: Workspace["instance"] };
} | null {
  const ws = findWorkspace(workspaces, wsId);
  const index = ws?.panes.findIndex((p) => p.id === paneId) ?? -1;
  if (!ws || index === -1) return null;
  return {
    title: paneDisplayTitle(ws.panes[index], index, agents),
    wsName: ws.name,
    workspace: { id: ws.id, instance: ws.instance },
  };
}

/** Bind a plugin's public workspace target to the lifetime that exists at
 * delivery. A missing id is represented explicitly so the notification can
 * never attach itself to a later workspace that reuses that slot. */
export function pluginNotificationSource(
  workspaces: Workspace[],
  pluginId: string,
  wsId?: string,
  dockTab?: string,
): Extract<NotificationSource, { type: "plugin" }> {
  const workspace =
    wsId === undefined ? undefined : findWorkspace(workspaces, wsId);
  return {
    type: "plugin",
    pluginId,
    ...(wsId !== undefined && {
      workspace: { id: wsId, instance: workspace?.instance ?? null },
    }),
    ...(dockTab !== undefined && { dockTab }),
  };
}

/** An agent's process died abnormally (non-zero code, or killed). Clean exits
 * never come here — they're the user's own doing, on screen. */
export function notifyAgentCrashed(
  workspaces: Workspace[],
  wsId: string,
  paneId: string,
  code: number | null,
  agents: AgentInfo[],
): void {
  const ctx = paneContext(workspaces, wsId, paneId, agents);
  if (!ctx) return; // the pane closed before the exit event landed
  notify({
    title: `${ctx.title} crashed`,
    body:
      code === null
        ? `Terminated · ${ctx.wsName}`
        : `Exit code ${code} · ${ctx.wsName}`,
    severity: "error",
    source: { type: "pane", workspace: ctx.workspace, paneId },
    tag: `pane:${paneId}:crash`,
  });
}

/** The spawn itself failed — there never was a process. */
export function notifyAgentSpawnFailed(
  workspaces: Workspace[],
  wsId: string,
  paneId: string,
  message: string,
  agents: AgentInfo[],
): void {
  const ctx = paneContext(workspaces, wsId, paneId, agents);
  if (!ctx) return;
  notify({
    title: `${ctx.title} failed to start`,
    body: `${message} · ${ctx.wsName}`,
    severity: "error",
    source: { type: "pane", workspace: ctx.workspace, paneId },
    tag: `pane:${paneId}:spawn`,
  });
}

let notifiedUpdateVersion: string | null = null;

/**
 * Watch the update flow and announce each newly-found version once. The
 * 4-hourly re-check keeps landing on `available` for the same version —
 * remembering the announced one is what keeps this quiet; a dismissed update
 * is not re-announced until a NEWER version appears. The memory is
 * deliberately per-run: a still-pending update earns one fresh reminder per
 * launch. A version found while notifications are OFF is not recorded — a
 * later re-enable lets the next check announce it.
 */
export function initUpdateNotifications(): () => void {
  return subscribeUpdates(() => {
    const state = getUpdateState();
    if (state.phase !== "available" || state.version === null) return;
    if (state.version === notifiedUpdateVersion) return;
    const prefs = getSettings()?.notifications ?? DEFAULT_SETTINGS.notifications;
    if (!prefs.enabled) return;
    notifiedUpdateVersion = state.version;
    notify({
      title: `KeepDeck ${state.version} is available`,
      body: "Open Settings → Updates to download it.",
      source: { type: "app" },
      tag: "app:update",
    });
  });
}

/** Test hook: forget which update version was announced. */
export function resetUpdateNotifications(): void {
  notifiedUpdateVersion = null;
}
