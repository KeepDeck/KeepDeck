// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../domain/settings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { NotificationsSection } from "./NotificationsSection";

const notifyIpc = vi.hoisted(() => ({
  notificationPermissionGranted: vi.fn(() => Promise.resolve(false)),
  ensureNotificationPermission: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../ipc/notify", () => notifyIpc);

const settings = vi.hoisted(() => ({
  current: null as Settings | null,
  listeners: new Set<() => void>(),
}));
vi.mock("../../app/settingsManager", () => ({
  getSettings: () => settings.current,
  subscribeSettings: (cb: () => void) => {
    settings.listeners.add(cb);
    return () => settings.listeners.delete(cb);
  },
  updateSettings: vi.fn(),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

function withPrefs(prefs: Partial<Settings["notifications"]>): void {
  settings.current = {
    ...DEFAULT_SETTINGS,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...prefs },
  };
}

describe("NotificationsSection permission handling", () => {
  let root: Root;

  beforeEach(() => {
    notifyIpc.notificationPermissionGranted.mockClear();
    notifyIpc.ensureNotificationPermission.mockClear();
    settings.current = null;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const mount = () =>
    act(() => root.render(createElement(NotificationsSection)));

  it("NEVER prompts on mount — the probe is the non-prompting read", async () => {
    // The dialog mounts every section on any settings open; a mount-time
    // prompt would ambush a user who came for a different page.
    for (const prefs of [
      {},
      { enabled: false },
      { mode: "app" as const },
      { mode: "system" as const },
    ]) {
      withPrefs(prefs);
      mount();
      await flush();
    }
    expect(notifyIpc.ensureNotificationPermission).not.toHaveBeenCalled();
    expect(notifyIpc.notificationPermissionGranted).toHaveBeenCalled();
  });

  it("the explicit Allow button is what requests permission", async () => {
    withPrefs({});
    mount();
    await flush();
    const allow = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Allow notifications",
    )!;
    expect(allow).toBeDefined();
    act(() => allow.click());
    await flush();
    expect(notifyIpc.ensureNotificationPermission).toHaveBeenCalledTimes(1);
    // Granted → the warning block disappears.
    expect(document.querySelector(".settings__hint--warn")).toBeNull();
  });

  it("a refused prompt switches to the System Settings guidance", async () => {
    notifyIpc.ensureNotificationPermission.mockResolvedValue(false);
    withPrefs({});
    mount();
    await flush();
    const allow = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Allow notifications",
    )!;
    act(() => allow.click());
    await flush();
    expect(
      document.querySelector(".settings__hint--warn")?.textContent,
    ).toContain("System Settings");
    // No second Allow button — the OS will not re-prompt.
    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Allow notifications",
      ),
    ).toBe(false);
  });

  it("no permission warning at all in the app-only mode", async () => {
    withPrefs({ mode: "app" });
    mount();
    await flush();
    expect(document.querySelector(".settings__hint--warn")).toBeNull();
  });
});
