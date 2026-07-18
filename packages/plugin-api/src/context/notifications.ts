import type { WorkspaceRef } from "./snapshots.ts";

/**
 * `ctx.notify` — a plugin's way to reach the host's notification center
 * (and, per the user's delivery settings, an OS banner). Requires the
 * `notifications` capability.
 *
 * The host owns everything the plugin must not: the entry is attributed
 * with the plugin's name (an entry cannot pose as a system event or as
 * another plugin's), the `tag` is namespaced per plugin, strings are
 * length-capped, and the flow is rate-limited — a chatty plugin's overflow
 * is dropped and logged, never queued.
 */
export interface PluginNotifyInput {
  title: string;
  body?: string;
  /** Defaults to `info`. */
  severity?: "info" | "warning" | "error";
  /** Bind the entry to one exact workspace lifetime: it counts toward that
   * workspace's unread dot and clicking it activates the workspace. */
  workspace?: WorkspaceRef;
  /** Clicking the entry opens this dock tab of the plugin (an entry id from
   * the manifest's `contributes.dockTabs`). */
  dockTab?: string;
  /** Replace-not-stack key (Web Notifications semantics), scoped to this
   * plugin: a new notification with the same tag replaces the previous one. */
  tag?: string;
}

export type PluginNotify = (input: PluginNotifyInput) => void;
