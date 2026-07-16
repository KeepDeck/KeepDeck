import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadState } from "@keepdeck/plugin-api";
import type { AvailableUpdate } from "../ipc/updater";
import {
  cancelUpdateDownload,
  checkForUpdatesNow,
  dismissUpdate,
  downloadUpdate,
  getUpdateState,
  initUpdates,
  resetUpdateManager,
  restartToUpdate,
} from "./updateManager";

vi.mock("../ipc/app", () => ({ fetchAppInfo: vi.fn() }));
vi.mock("../ipc/updater", () => ({
  checkForUpdate: vi.fn(),
  discardUpdate: vi.fn(async () => {}),
  installUpdate: vi.fn(async () => {}),
  relaunchApp: vi.fn(async () => {}),
}));
vi.mock("../ipc/log", () => ({
  describeError: (error: unknown) =>
    String(error instanceof Error ? error.message : error),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fetchAppInfo } from "../ipc/app";
import {
  checkForUpdate,
  discardUpdate,
  installUpdate,
  relaunchApp,
} from "../ipc/updater";

const mockInfo = vi.mocked(fetchAppInfo);
const mockCheck = vi.mocked(checkForUpdate);
const mockDiscard = vi.mocked(discardUpdate);
const mockInstall = vi.mocked(installUpdate);
const mockRelaunch = vi.mocked(relaunchApp);

const available = (version = "1.2.0"): AvailableUpdate => ({
  id: `update-${version}`,
  version,
  downloaded: false,
  download: {
    source: { url: "https://example.com/update" },
    target: { kind: "file", path: `updates/${version}.bundle` },
    integrity: { kind: "size", bytes: 100 },
  },
});

let states: Omit<DownloadState, "id">[];
let downloadError: Error | null;
const downloads = {
  start: vi.fn((request: { id: string }) => ({
    async *[Symbol.asyncIterator]() {
      if (downloadError) throw downloadError;
      for (const state of states) yield { id: request.id, ...state };
    },
  })),
  cancel: vi.fn(async () => {}),
};

beforeEach(() => {
  vi.useFakeTimers();
  states = [
    { phase: "downloading", received: 60, total: 100 },
    { phase: "completed", received: 100, total: 100 },
  ];
  downloadError = null;
  mockInfo.mockResolvedValue({ name: "KeepDeck", version: "0.13.2", updater: true });
});

afterEach(() => {
  resetUpdateManager();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("update manager", () => {
  it("stays disabled when this build has no updater", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "0.13.2", updater: false });
    await initUpdates(downloads);
    expect(getUpdateState().phase).toBe("disabled");
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("checks immediately and periodically", async () => {
    mockCheck.mockResolvedValue(null);
    await initUpdates(downloads, 1_000);
    expect(getUpdateState().phase).toBe("idle");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mockCheck).toHaveBeenCalledTimes(3);
  });

  it("returns to idle and records a failed check", async () => {
    mockCheck.mockRejectedValueOnce(new Error("offline"));
    await initUpdates(downloads);
    expect(getUpdateState()).toMatchObject({ phase: "idle", error: "offline" });
  });

  it("finds an update without downloading before consent", async () => {
    mockCheck.mockResolvedValue(available());
    await initUpdates(downloads);
    expect(getUpdateState()).toMatchObject({ phase: "available", version: "1.2.0" });
    expect(downloads.start).not.toHaveBeenCalled();
  });

  it("reuses a previously verified deterministic artifact after restart", async () => {
    mockCheck.mockResolvedValue({ ...available(), downloaded: true });
    await initUpdates(downloads);
    expect(getUpdateState()).toMatchObject({ phase: "ready", version: "1.2.0" });
    expect(downloads.start).not.toHaveBeenCalled();
  });

  it("downloads through the shared manager and waits in ready", async () => {
    mockCheck.mockResolvedValue(available());
    await initUpdates(downloads);
    await downloadUpdate();
    expect(downloads.start).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        source: { url: "https://example.com/update" },
      }),
    );
    expect(getUpdateState()).toMatchObject({
      phase: "ready",
      received: 100,
      total: 100,
    });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("returns to available when the shared stream fails", async () => {
    mockCheck.mockResolvedValue(available());
    await initUpdates(downloads);
    downloadError = new Error("signature mismatch");
    await downloadUpdate();
    expect(getUpdateState()).toMatchObject({
      phase: "available",
      error: "signature mismatch",
    });
  });

  it("cancels the active download job by its unique id", async () => {
    mockCheck.mockResolvedValue(available());
    await initUpdates(downloads);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    downloads.start.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { id: "held", phase: "downloading", received: 1, total: 10 } as const;
        await held;
        yield { id: "held", phase: "cancelled", received: 1, total: 10 } as const;
      },
    });
    const pending = downloadUpdate();
    await Promise.resolve();
    cancelUpdateDownload();
    expect(downloads.cancel).toHaveBeenCalledWith(expect.any(String));
    release();
    await pending;
    expect(getUpdateState().phase).toBe("available");
  });

  it("installs verified bytes and relaunches only from ready", async () => {
    const update = available();
    mockCheck.mockResolvedValue(update);
    await initUpdates(downloads);
    await downloadUpdate();
    await restartToUpdate();
    expect(mockInstall).toHaveBeenCalledWith(update.id);
    expect(mockRelaunch).toHaveBeenCalledOnce();
  });

  it("keeps a verified update ready when installation fails", async () => {
    mockCheck.mockResolvedValue(available());
    mockInstall.mockRejectedValueOnce(new Error("install denied"));
    await initUpdates(downloads);
    await downloadUpdate();
    await restartToUpdate();
    expect(getUpdateState()).toMatchObject({ phase: "ready", error: "install denied" });
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("does not offer a second install after only relaunch fails", async () => {
    mockCheck.mockResolvedValue(available());
    mockRelaunch.mockRejectedValueOnce(new Error("relaunch blocked"));
    await initUpdates(downloads);
    await downloadUpdate();
    await restartToUpdate();
    expect(getUpdateState()).toMatchObject({
      phase: "installing",
      error: expect.stringContaining("quit and reopen"),
    });
    await restartToUpdate();
    expect(mockInstall).toHaveBeenCalledOnce();
  });

  it("dismisses metadata and downloaded bytes", async () => {
    const update = available();
    mockCheck.mockResolvedValue(update);
    await initUpdates(downloads);
    await dismissUpdate();
    expect(mockDiscard).toHaveBeenCalledWith(update.id);
    expect(getUpdateState().phase).toBe("idle");
  });

  it("does not claim dismissal before native cleanup settles", async () => {
    const update = available();
    mockCheck.mockResolvedValue(update);
    let release!: () => void;
    mockDiscard.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await initUpdates(downloads);

    const dismissing = dismissUpdate();
    expect(getUpdateState().phase).toBe("discarding");
    checkForUpdatesNow();
    expect(mockCheck).toHaveBeenCalledOnce();
    release();
    await dismissing;
    expect(getUpdateState().phase).toBe("idle");
  });

  it("keeps the update actionable when native cleanup fails", async () => {
    mockCheck.mockResolvedValue(available());
    mockDiscard.mockRejectedValueOnce(new Error("artifact busy"));
    await initUpdates(downloads);

    await dismissUpdate();

    expect(getUpdateState()).toMatchObject({
      phase: "available",
      error: "artifact busy",
    });
  });

  it("manual checks run only from idle", async () => {
    mockCheck.mockResolvedValue(null);
    await initUpdates(downloads);
    checkForUpdatesNow();
    await Promise.resolve();
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });
});
