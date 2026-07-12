// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initUpdates, resetUpdateManager } from "../../app/updateManager";
import type { Update } from "../../ipc/updater";
import { UpdatesSection } from "./UpdatesSection";

vi.mock("../../ipc/app", () => ({ fetchAppInfo: vi.fn() }));
vi.mock("../../ipc/updater", () => ({
  checkForUpdate: vi.fn(),
  relaunchApp: vi.fn(),
}));
vi.mock("../../ipc/log", () => ({
  describeError: (e: unknown) => String(e instanceof Error ? e.message : e),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fetchAppInfo } from "../../ipc/app";
import { checkForUpdate } from "../../ipc/updater";

const mockInfo = vi.mocked(fetchAppInfo);
const mockCheck = vi.mocked(checkForUpdate);

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

function fakeUpdate(version: string): Update {
  return {
    version,
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
  } as unknown as Update;
}

describe("UpdatesSection", () => {
  it("shows the installed version and a disabled action in a dev build", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: false });
    await initUpdates();
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
    await initUpdates();
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
    await initUpdates();
    await render();

    expect(hints()).toContain("Version 1.2.0 is available");
    expect(hints()).toContain("nothing has been downloaded");
    expect(update.download).not.toHaveBeenCalled();

    await act(async () => button("Download update").click());
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();
    expect(hints()).toContain("nothing changes until you restart");
  });

  it("the downloaded update installs only on the restart click", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: true });
    const update = fakeUpdate("1.2.0");
    mockCheck.mockResolvedValue(update);
    await initUpdates();
    await render();
    await act(async () => button("Download update").click());

    await act(async () => button("Restart to update").click());
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  it("Dismiss backs out of a found update", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: true });
    mockCheck.mockResolvedValue(fakeUpdate("1.2.0"));
    await initUpdates();
    await render();

    await act(async () => button("Dismiss").click());
    expect(hints()).toContain("Up to date");
    expect(button("Check for updates").disabled).toBe(false);
  });

  it("surfaces a failed check without blocking the next one", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "9.9.9", updater: true });
    mockCheck.mockRejectedValue(new Error("offline"));
    await initUpdates();
    await render();

    expect(hints()).toContain("Last check failed: offline");
    expect(button("Check for updates").disabled).toBe(false);
  });
});
