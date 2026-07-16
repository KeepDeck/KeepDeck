import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureNotificationPermission,
  resetNotifyIpc,
  sendSystemNotification,
} from "./notify";

const os = vi.hoisted(() => ({
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<string>>(),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => os);

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("notification permission", () => {
  beforeEach(() => {
    resetNotifyIpc();
    os.isPermissionGranted.mockReset();
    os.requestPermission.mockReset();
    os.sendNotification.mockClear();
  });

  it("a System-Settings grant is honored mid-run — the denial is not cached", async () => {
    // First send: not granted, the prompt is refused.
    os.isPermissionGranted.mockResolvedValue(false);
    os.requestPermission.mockResolvedValue("denied");
    sendSystemNotification("first");
    await flush();
    expect(os.sendNotification).not.toHaveBeenCalled();

    // The user flips it in System Settings; the next send must go through.
    os.isPermissionGranted.mockResolvedValue(true);
    sendSystemNotification("second");
    await flush();
    expect(os.sendNotification).toHaveBeenCalledWith({ title: "second" });
  });

  it("prompts at most once per run, however many denied sends pile up", async () => {
    os.isPermissionGranted.mockResolvedValue(false);
    os.requestPermission.mockResolvedValue("denied");
    sendSystemNotification("a");
    sendSystemNotification("b");
    await flush();
    await ensureNotificationPermission();
    expect(os.requestPermission).toHaveBeenCalledTimes(1);
    expect(os.sendNotification).not.toHaveBeenCalled();
  });

  it("an accepted prompt delivers the very send that triggered it", async () => {
    os.isPermissionGranted.mockResolvedValueOnce(false); // pre-prompt read
    os.requestPermission.mockResolvedValue("granted");
    os.isPermissionGranted.mockResolvedValue(true); // post-prompt re-read
    sendSystemNotification("hello", "world");
    await flush();
    expect(os.sendNotification).toHaveBeenCalledWith({
      title: "hello",
      body: "world",
    });
  });

  it("a failing permission API degrades to no banner, never a throw", async () => {
    os.isPermissionGranted.mockRejectedValue(new Error("no bridge"));
    os.requestPermission.mockRejectedValue(new Error("no bridge"));
    sendSystemNotification("x");
    await flush();
    expect(os.sendNotification).not.toHaveBeenCalled();
    await expect(ensureNotificationPermission()).resolves.toBe(false);
  });
});
