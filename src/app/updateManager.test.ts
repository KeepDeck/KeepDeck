import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent, Update } from "../ipc/updater";
import {
  checkForUpdatesNow,
  dismissUpdate,
  downloadUpdate,
  getUpdateState,
  initUpdates,
  resetUpdateManager,
  restartToUpdate,
  subscribeUpdates,
} from "./updateManager";

vi.mock("../ipc/app", () => ({ fetchAppInfo: vi.fn() }));
vi.mock("../ipc/updater", () => ({
  checkForUpdate: vi.fn(),
  relaunchApp: vi.fn(),
}));
vi.mock("../ipc/log", () => ({
  describeError: (e: unknown) => String(e instanceof Error ? e.message : e),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fetchAppInfo } from "../ipc/app";
import { checkForUpdate, relaunchApp } from "../ipc/updater";

const mockInfo = vi.mocked(fetchAppInfo);
const mockCheck = vi.mocked(checkForUpdate);
const mockRelaunch = vi.mocked(relaunchApp);

function appInfo(updater: boolean) {
  return { name: "KeepDeck", version: "0.12.1", updater };
}

/** A fake plugin Update handle: download replays the given events. */
function fakeUpdate(
  version: string,
  events: DownloadEvent[] = [{ event: "Finished" }],
): Update {
  return {
    version,
    download: vi.fn(async (onEvent?: (e: DownloadEvent) => void) => {
      for (const event of events) onEvent?.(event);
    }),
    install: vi.fn(async () => {}),
  } as unknown as Update;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetUpdateManager();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("initUpdates", () => {
  it("stays disabled when the build carries no updater", async () => {
    mockInfo.mockResolvedValue(appInfo(false));
    await initUpdates();
    expect(getUpdateState().phase).toBe("disabled");
    expect(mockCheck).not.toHaveBeenCalled();
    // And the interval never fires a check either.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("goes disabled when even app_info is unreachable", async () => {
    mockInfo.mockRejectedValue(new Error("no bridge"));
    await initUpdates();
    expect(getUpdateState().phase).toBe("disabled");
  });

  it("checks immediately and lands idle when we are current", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(null);
    await initUpdates();
    const state = getUpdateState();
    expect(state.phase).toBe("idle");
    expect(state.checkedAt).not.toBeNull();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: repeated calls share one boot", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(null);
    await Promise.all([initUpdates(), initUpdates()]);
    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("re-checks on the interval", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(null);
    await initUpdates(1000);
    expect(mockCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(mockCheck).toHaveBeenCalledTimes(3);
  });
});

describe("finding an update", () => {
  it("stops at available — zero bytes move without consent", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    const update = fakeUpdate("1.2.0");
    mockCheck.mockResolvedValue(update);
    await initUpdates();

    const state = getUpdateState();
    expect(state.phase).toBe("available");
    expect(state.version).toBe("1.2.0");
    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
  });

  it("a failed check surfaces the error and returns to idle", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockRejectedValue(new Error("offline"));
    await initUpdates();
    const state = getUpdateState();
    expect(state.phase).toBe("idle");
    expect(state.error).toBe("offline");
  });

  it("a periodic tick while available or ready does not re-check", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(fakeUpdate("1.2.0"));
    await initUpdates(1000);
    expect(getUpdateState().phase).toBe("available");
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockCheck).toHaveBeenCalledTimes(1);

    await downloadUpdate();
    expect(getUpdateState().phase).toBe("ready");
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

describe("downloadUpdate", () => {
  it("downloads with progress and waits in ready", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    const update = fakeUpdate("1.2.0", [
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 60 } },
      { event: "Progress", data: { chunkLength: 40 } },
      { event: "Finished" },
    ] as DownloadEvent[]);
    mockCheck.mockResolvedValue(update);
    const phases: string[] = [];
    subscribeUpdates(() => phases.push(getUpdateState().phase));
    await initUpdates();

    await downloadUpdate();

    const state = getUpdateState();
    expect(state.phase).toBe("ready");
    expect(state.received).toBe(100);
    expect(state.total).toBe(100);
    expect(phases).toContain("downloading");
    // Downloaded, NOT installed — that waits for the user.
    expect(update.install).not.toHaveBeenCalled();
  });

  it("a failed download returns to available for a retry", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    const update = fakeUpdate("1.2.0");
    (update.download as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("signature mismatch"),
    );
    mockCheck.mockResolvedValue(update);
    await initUpdates();

    await downloadUpdate();

    const state = getUpdateState();
    expect(state.phase).toBe("available");
    expect(state.error).toBe("signature mismatch");
  });

  it("is a no-op unless an update is available", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(null);
    await initUpdates();
    await downloadUpdate();
    expect(getUpdateState().phase).toBe("idle");
  });
});

describe("dismissUpdate", () => {
  it("forgets a found update; the next check offers it again", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(fakeUpdate("1.2.0"));
    await initUpdates(1000);
    expect(getUpdateState().phase).toBe("available");

    dismissUpdate();
    expect(getUpdateState().phase).toBe("idle");
    expect(getUpdateState().version).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    expect(getUpdateState().phase).toBe("available");
  });

  it("forgets a downloaded update too", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(fakeUpdate("1.2.0"));
    await initUpdates();
    await downloadUpdate();
    expect(getUpdateState().phase).toBe("ready");

    dismissUpdate();
    expect(getUpdateState().phase).toBe("idle");
    // A dismissed download cannot be installed by a later stray call.
    await restartToUpdate();
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("is a no-op in other phases", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(null);
    await initUpdates();
    dismissUpdate();
    expect(getUpdateState().phase).toBe("idle");
  });
});

describe("checkForUpdatesNow", () => {
  it("runs a check from idle", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(null);
    await initUpdates();
    checkForUpdatesNow();
    await Promise.resolve(); // let the in-flight check settle
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  it("is a no-op while disabled", async () => {
    mockInfo.mockResolvedValue(appInfo(false));
    await initUpdates();
    checkForUpdatesNow();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("is a no-op while an update awaits a decision", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(fakeUpdate("1.2.0"));
    await initUpdates();
    expect(getUpdateState().phase).toBe("available");
    checkForUpdatesNow();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

describe("restartToUpdate", () => {
  async function readyState() {
    mockInfo.mockResolvedValue(appInfo(true));
    const update = fakeUpdate("1.2.0");
    mockCheck.mockResolvedValue(update);
    await initUpdates();
    await downloadUpdate();
    expect(getUpdateState().phase).toBe("ready");
    return update;
  }

  it("installs the downloaded update, then relaunches", async () => {
    const update = await readyState();

    await restartToUpdate();

    expect(update.install).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(getUpdateState().phase).toBe("installing");
  });

  it("returns to ready with the error when the install fails", async () => {
    const update = await readyState();
    (update.install as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("permission denied"),
    );

    await restartToUpdate();

    const state = getUpdateState();
    expect(state.phase).toBe("ready");
    expect(state.error).toBe("permission denied");
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("is a no-op unless an update is ready", async () => {
    mockInfo.mockResolvedValue(appInfo(true));
    mockCheck.mockResolvedValue(fakeUpdate("1.2.0"));
    await initUpdates();
    // available, but not downloaded — installing from here must be impossible
    await restartToUpdate();
    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(getUpdateState().phase).toBe("available");
  });
});
