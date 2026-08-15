import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../domain/settings";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { DEFAULT_SETTINGS } from "../domain/settings";
import {
  createNotificationCenter,
  type NotificationCenter,
} from "./notificationCenter";
import { setWindowFocusForTest } from "./windowFocus";

const notifyIpc = vi.hoisted(() => ({
  sendSystemNotification: vi.fn<(title: string, body?: string) => void>(),
}));
vi.mock("../ipc/notify", () => notifyIpc);

const windowIpc = vi.hoisted(() => ({
  onWindowFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  windowIsFocused: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../ipc/window", () => windowIpc);

const settings = vi.hoisted(() => ({
  current: null as Settings | null,
}));
vi.mock("./settingsManager", () => ({
  getSettings: () => settings.current,
}));

function withNotificationPrefs(
  prefs: Partial<Settings["notifications"]>,
): void {
  settings.current = {
    ...DEFAULT_SETTINGS,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...prefs },
  };
}

const paneSource = {
  type: "pane",
  workspace: { id: "ws-1", instance: createWorkspaceInstance() },
  paneId: "p-1",
} as const;

let {
  clearAllNotifications,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notify,
  setSourceVisibilityProbe,
  subscribeNotifications,
}: NotificationCenter = createNotificationCenter();

describe("notificationCenter", () => {
  beforeEach(() => {
    ({
      clearAllNotifications,
      getNotifications,
      markAllNotificationsRead,
      markNotificationRead,
      notify,
      setSourceVisibilityProbe,
      subscribeNotifications,
    } = createNotificationCenter());
    notifyIpc.sendSystemNotification.mockClear();
    settings.current = null; // pre-boot: DEFAULT_SETTINGS apply
    setWindowFocusForTest(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("isolates the state and subscribers of independently created centers", () => {
    const first = createNotificationCenter();
    const second = createNotificationCenter();
    const firstListener = vi.fn();
    first.subscribeNotifications(firstListener);

    first.notify({ title: "first", source: { type: "app" } });

    expect(first.getNotifications()).toHaveLength(1);
    expect(second.getNotifications()).toHaveLength(0);
    expect(firstListener).toHaveBeenCalledTimes(1);

    second.notify({ title: "second", source: { type: "app" } });
    expect(first.getNotifications()[0].title).toBe("first");
    expect(firstListener).toHaveBeenCalledTimes(1);
  });

  it("records the notification and posts a banner (default mode, unfocused)", () => {
    notify({ title: "Agent crashed", source: paneSource, severity: "error" });
    expect(getNotifications()).toHaveLength(1);
    expect(getNotifications()[0]).toMatchObject({
      title: "Agent crashed",
      severity: "error",
      source: paneSource,
    });
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledWith(
      "Agent crashed",
      undefined,
    );
  });

  it("severity defaults to info; listeners fire per change", () => {
    const listener = vi.fn();
    subscribeNotifications(listener);
    notify({ title: "t", source: { type: "app" } });
    expect(getNotifications()[0].severity).toBe("info");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("master switch off drops everything", () => {
    withNotificationPrefs({ enabled: false });
    notify({ title: "t", source: paneSource });
    expect(getNotifications()).toHaveLength(0);
    expect(notifyIpc.sendSystemNotification).not.toHaveBeenCalled();
  });

  it("mode=system keeps the list empty but banners", () => {
    withNotificationPrefs({ mode: "system" });
    notify({ title: "t", source: paneSource });
    expect(getNotifications()).toHaveLength(0);
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it("mode=app records but never touches the OS", () => {
    withNotificationPrefs({ mode: "app" });
    notify({ title: "t", source: paneSource });
    expect(getNotifications()).toHaveLength(1);
    expect(notifyIpc.sendSystemNotification).not.toHaveBeenCalled();
  });

  it("suppresses the banner when the source is on screen in a focused window", () => {
    setWindowFocusForTest(true);
    setSourceVisibilityProbe((source) => source.type === "pane");
    notify({ title: "t", source: paneSource });
    expect(getNotifications()).toHaveLength(1); // still recorded
    expect(notifyIpc.sendSystemNotification).not.toHaveBeenCalled();
  });

  it("banners when focused but the source is off screen", () => {
    setWindowFocusForTest(true);
    setSourceVisibilityProbe(() => false);
    notify({ title: "t", source: paneSource });
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it("counts watched-in-place as delivered in system mode; cooldown as not", () => {
    withNotificationPrefs({ mode: "system" });
    setWindowFocusForTest(true);
    setSourceVisibilityProbe(() => true);
    // The user is looking at the source surface: no banner, but the event
    // announced itself in place — a persisting caller must not re-announce.
    expect(notify({ title: "t", source: paneSource, tag: "a" })).toBe(true);
    expect(notifyIpc.sendSystemNotification).not.toHaveBeenCalled();

    // Cooldown suppression reaches nobody THIS time — stays undelivered.
    setSourceVisibilityProbe(() => false);
    expect(notify({ title: "t", source: paneSource, tag: "b" })).toBe(true);
    expect(notify({ title: "t", source: paneSource, tag: "b" })).toBe(false);
  });

  it("same-tag banners respect the cooldown; the entry still updates", () => {
    notify({ title: "first", source: paneSource, tag: "x" });
    vi.advanceTimersByTime(1_000);
    notify({ title: "second", source: paneSource, tag: "x" });
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(1);
    expect(getNotifications()).toHaveLength(1);
    expect(getNotifications()[0].title).toBe("second");
    vi.advanceTimersByTime(10_000);
    notify({ title: "third", source: paneSource, tag: "x" });
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(2);
  });

  it("the cooldown is keyed per tag, or per source when untagged", () => {
    notify({ title: "a", source: paneSource, tag: "tag-a" });
    vi.advanceTimersByTime(1_000);
    // A different tag inside tag-a's window still banners…
    notify({ title: "b", source: paneSource, tag: "tag-b" });
    // …and so does a DIFFERENT untagged source…
    notify({ title: "c", source: { type: "app" } });
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(3);
    // …but untagged entries from ONE source share its cooldown: a pane
    // emitting a stream of separate history entries must not banner per
    // entry — the entry still lands, only the banner waits.
    notify({ title: "u1", source: paneSource });
    notify({ title: "u2", source: paneSource });
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(4);
    expect(getNotifications().map((n) => n.title)).toEqual([
      "u2",
      "u1",
      "c",
      "b",
      "a",
    ]);
  });

  it("the cooldown memory is bounded: the coldest tag is evicted, not leaked", () => {
    notify({ title: "first", source: paneSource, tag: "tag-first" });
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(1);
    // 512 fresh tags push "tag-first" out of the bounded map…
    for (let i = 0; i < 512; i += 1) {
      notify({ title: `n${i}`, source: paneSource, tag: `tag-${i}` });
    }
    // …so its cooldown is forgotten: a re-banner inside the 5s window goes
    // through (the safe failure direction — redundant, never swallowed).
    notify({ title: "again", source: paneSource, tag: "tag-first" });
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(514);
  });

  it("mutes a plugin's notifications without touching others", () => {
    withNotificationPrefs({ mutedPlugins: ["keepdeck.git"] });
    notify({
      title: "muted",
      source: { type: "plugin", pluginId: "keepdeck.git" },
    });
    notify({
      title: "loud",
      source: { type: "plugin", pluginId: "keepdeck.run" },
    });
    expect(getNotifications()).toHaveLength(1);
    expect(getNotifications()[0].title).toBe("loud");
  });

  it("read state flows through and no-ops keep the snapshot reference", () => {
    notify({ title: "a", source: paneSource });
    notify({ title: "b", source: paneSource });
    const [b] = getNotifications();
    markNotificationRead(b.id);
    expect(
      getNotifications().find((n) => n.id === b.id)?.readAt,
    ).toBeDefined();
    const snapshot = getNotifications();
    markNotificationRead("unknown");
    expect(getNotifications()).toBe(snapshot);
    markAllNotificationsRead();
    expect(getNotifications().every((n) => n.readAt !== undefined)).toBe(true);
  });

  it("clears in-app history once while preserving the banner cooldown", () => {
    notify({ title: "first", source: paneSource, tag: "x" });
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(1);

    const listener = vi.fn();
    const unsubscribe = subscribeNotifications(listener);
    clearAllNotifications();
    expect(getNotifications()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);

    clearAllNotifications();
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    notify({ title: "second", source: paneSource, tag: "x" });
    expect(getNotifications()).toHaveLength(1);
    expect(notifyIpc.sendSystemNotification).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
