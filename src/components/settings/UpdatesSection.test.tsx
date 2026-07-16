// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initUpdates, resetUpdateManager } from "../../app/updateManager";
import type { AvailableUpdate } from "../../ipc/updater";
import { UpdatesSection } from "./UpdatesSection";

vi.mock("../../ipc/app", () => ({ fetchAppInfo: vi.fn() }));
vi.mock("../../ipc/updater", () => ({
  checkForUpdate: vi.fn(),
  discardUpdate: vi.fn(async () => {}),
  installUpdate: vi.fn(async () => {}),
  relaunchApp: vi.fn(async () => {}),
}));
vi.mock("../../ipc/log", () => ({
  describeError: (e: unknown) => String(e instanceof Error ? e.message : e),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fetchAppInfo } from "../../ipc/app";
import { checkForUpdate, installUpdate } from "../../ipc/updater";

const mockInfo = vi.mocked(fetchAppInfo);
const mockCheck = vi.mocked(checkForUpdate);
const mockInstall = vi.mocked(installUpdate);
const downloads = {
  start: vi.fn((request: { id: string }) => ({
    async *[Symbol.asyncIterator]() {
      yield {
        id: request.id,
        phase: "completed" as const,
        received: 100,
        total: 100,
      };
    },
  })),
  cancel: vi.fn(async () => {}),
};

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetUpdateManager();
  vi.clearAllMocks();
});

async function render() {
  await act(async () => {
    root.render(createElement(UpdatesSection));
  });
}

const buttons = () => [...host.querySelectorAll("button")];
const button = (label: string) => {
  const found = buttons().find((b) => b.textContent === label);
  if (!found) {
    throw new Error(
      `no button "${label}"; have: ${buttons().map((b) => b.textContent).join(", ")}`,
    );
  }
  return found;
};
const hints = () =>
  [...host.querySelectorAll(".settings__hint")].map((el) => el.textContent).join(" ");

function fakeUpdate(version: string): AvailableUpdate {
  return {
    id: `update-${version}`,
    version,
    downloaded: false,
    download: {
      source: { url: "https://example.com/update" },
      target: { kind: "file", path: `updates/${version}.bundle` },
    },
  };
}

describe("UpdatesSection", () => {
  it("shows the installed version and a disabled action in a dev build", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: false });
    await initUpdates(downloads);
    await render();

    expect(host.querySelector(".settings__value")!.textContent).toBe(
      "KeepDeck 9.9.9",
    );
    expect(button("Check for updates").disabled).toBe(true);
    expect(hints()).toContain("release builds only");
  });

  it("checks on demand from idle", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: true });
    mockCheck.mockResolvedValue(null);
    await initUpdates(downloads);
    await render();

    expect(button("Check for updates").disabled).toBe(false);
    expect(hints()).toContain("Up to date");
    await act(async () => button("Check for updates").click());
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  it("a found update offers Download and Dismiss — and downloads nothing", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: true });
    const update = fakeUpdate("1.2.0");
    mockCheck.mockResolvedValue(update);
    await initUpdates(downloads);
    await render();

    expect(hints()).toContain("Version 1.2.0 is available");
    expect(hints()).toContain("nothing has been downloaded");
    expect(downloads.start).not.toHaveBeenCalled();

    await act(async () => button("Download update").click());
    expect(downloads.start).toHaveBeenCalledTimes(1);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(hints()).toContain("nothing changes until you restart");
  });

  it("the downloaded update installs only on the restart click", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: true });
    const update = fakeUpdate("1.2.0");
    mockCheck.mockResolvedValue(update);
    await initUpdates(downloads);
    await render();
    await act(async () => button("Download update").click());

    await act(async () => button("Restart to update").click());
    expect(mockInstall).toHaveBeenCalledWith(update.id);
  });

  it("Dismiss backs out of a found update", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: true });
    mockCheck.mockResolvedValue(fakeUpdate("1.2.0"));
    await initUpdates(downloads);
    await render();

    await act(async () => button("Dismiss").click());
    expect(hints()).toContain("Up to date");
    expect(button("Check for updates").disabled).toBe(false);
  });

  it("surfaces a failed check without blocking the next one", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: true });
    mockCheck.mockRejectedValue(new Error("offline"));
    await initUpdates(downloads);
    await render();

    expect(hints()).toContain("Last check failed: offline");
    expect(button("Check for updates").disabled).toBe(false);
  });
});
