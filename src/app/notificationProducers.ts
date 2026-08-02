import type { WorkspaceRef as PluginWorkspaceRef } from "@keepdeck/plugin-api";
import {
  findWorkspace,
  paneDisplayTitle,
  type Workspace,
} from "../domain/deck";
import type { AgentInfo } from "../domain/agents";
import type { NotificationSource } from "../domain/notifications";
import { activityBadge, type PaneActivity } from "../domain/status";
import type { WorkspaceInstance } from "../domain/workspaceInstance";
import { DEFAULT_SETTINGS } from "../domain/settings";
import type { AgentStatusTracker } from "./agentStatusTracker";
import { notify, retractNotification } from "./notificationCenter";
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

/** Preserve the exact workspace lifetime supplied by a plugin notification so
 * delayed delivery can never attach to a replacement that reused its id. */
export function pluginNotificationSource(
  pluginId: string,
  workspace?: PluginWorkspaceRef,
  dockTab?: string,
): Extract<NotificationSource, { type: "plugin" }> {
  return {
    type: "plugin",
    pluginId,
    ...(workspace !== undefined && {
      workspace: {
        id: workspace.id,
        instance: workspace.instance as WorkspaceInstance,
      },
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

/** [`paneContext`] when only the pane id is known (the status tracker keys
 * by pane alone) — the deck is scanned for the owning workspace. */
function paneContextById(
  workspaces: Workspace[],
  paneId: string,
  agents: AgentInfo[],
) {
  for (const ws of workspaces) {
    if (ws.panes.some((p) => p.id === paneId)) {
      return paneContext(workspaces, ws.id, paneId, agents);
    }
  }
  return null;
}

/**
 * Watch the activity tracker and announce the transitions worth leaving the
 * app for: the agent needs the user (approval or a question), finished a
 * turn, or died on an API error. One tag per pane, replace-not-stack — a
 * "needs approval" banner is superseded by the "finished" that follows it,
 * never stacked under it. Suppression while the pane is on screen is the
 * center's own rule ([`shouldBanner`]), not re-derived here.
 *
 * `read` supplies the deck facts a message needs (names change and panes
 * close while this subscription lives) — the composition root binds it.
 */
export function initActivityNotifications(
  tracker: AgentStatusTracker,
  read: () => { workspaces: Workspace[]; agents: AgentInfo[] },
): () => void {
  let prev: ReadonlyMap<string, PaneActivity> = tracker.getSnapshot().panes;
  return tracker.subscribe(() => {
    const next = tracker.getSnapshot().panes;
    const { workspaces, agents } = read();
    for (const [paneId, activity] of next) {
      const before = prev.get(paneId);
      if (before === activity) continue;
      announceActivity(workspaces, paneId, before, activity, agents);
    }
    prev = next;
  });
}

function announceActivity(
  workspaces: Workspace[],
  paneId: string,
  before: PaneActivity | undefined,
  activity: PaneActivity,
  agents: AgentInfo[],
): void {
  const badge = activityBadge(activity);
  const tag = `pane:${paneId}:activity`;
  const ctx = () => paneContextById(workspaces, paneId, agents);
  // An ANSWERED wait is no longer news: the user resolved the prompt in
  // the pane (the turn resumed) or cut the turn with their own hand — a
  // standing "needs approval" would now report a wait that doesn't exist.
  // The states that announce (done, failed) replace the same tag instead.
  if (
    before?.state === "waiting" &&
    (activity.state === "working" ||
      (activity.state === "done" && activity.interrupted))
  ) {
    retractNotification(tag);
    return;
  }
  if (activity.state === "waiting" && before?.state !== "waiting") {
    const c = ctx();
    if (!c) return;
    notify({
      title: `${c.title} — ${badge.sentence}`,
      body: c.wsName,
      severity: "warning",
      source: { type: "pane", workspace: c.workspace, paneId },
      tag,
    });
    return;
  }
  if (activity.state === "failed") {
    const c = ctx();
    if (!c) return;
    // `sentence`, not a lowercased label: a CLI's own error identifier must
    // keep its casing ("failed: QuotaCliff", never "failed: quotacliff").
    notify({
      title: `${c.title} — ${badge.sentence}`,
      body: activity.detail ? `${activity.detail} · ${c.wsName}` : c.wsName,
      severity: "error",
      source: { type: "pane", workspace: c.workspace, paneId },
      tag,
    });
    return;
  }
  // Finished — but only a turn that was actually RUNNING here, and only one
  // the agent ended itself: an interrupt is the user's own hand, they are
  // looking at the pane.
  if (
    activity.state === "done" &&
    !activity.interrupted &&
    (before?.state === "working" || before?.state === "waiting")
  ) {
    const c = ctx();
    if (!c) return;
    notify({
      title: `${c.title} finished`,
      body: c.wsName,
      source: { type: "pane", workspace: c.workspace, paneId },
      tag,
    });
  }
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
