import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../domain/settings";
import { DEFAULT_SETTINGS } from "../domain/settings";
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notify,
  resetNotificationCenter,
  setSourceVisibilityProbe,
  subscribeNotifications,
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

const paneSource = { type: "pane", wsId: "ws-1", paneId: "p-1" } as const;

describe("notificationCenter", () => {
  beforeEach(() => {
    resetNotificationCenter();
    notifyIpc.sendSystemNotification.mockClear();
    settings.current = null; // pre-boot: DEFAULT_SETTINGS apply
    setWindowFocusForTest(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetNotificationCenter();
    vi.useRealTimers();
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
});
