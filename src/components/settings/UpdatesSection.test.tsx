// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initUpdates, resetUpdateManager } from "../../app/updateManager";
import type { AvailableUpdate } from "../../ipc/updater";
import { UpdatesSection } from "./UpdatesSection";

vi.mock("../../ipc/app", () => ({
  fetchAppInfo: vi.fn(),
  openUrl: vi.fn(async () => {}),
}));
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

import { fetchAppInfo, openUrl } from "../../ipc/app";
import { checkForUpdate, installUpdate } from "../../ipc/updater";

const mockInfo = vi.mocked(fetchAppInfo);
const mockCheck = vi.mocked(checkForUpdate);
const mockInstall = vi.mocked(installUpdate);
const mockOpenUrl = vi.mocked(openUrl);
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
    changelog: [],
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

  it("renders the accumulated changelog for a found update", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "0.13.0", updater: true });
    mockCheck.mockResolvedValue({
      ...fakeUpdate("1.2.0"),
      changelog: [
        { version: "1.0.0", notes: "First **bold** step.", date: "2026-07-01" },
        { version: "1.2.0", notes: "- a\n- b" },
      ],
    });
    await initUpdates(downloads);
    await render();

    const versions = [...host.querySelectorAll(".settings__changelog-version span")].map(
      (el) => el.textContent,
    );
    expect(versions).toEqual(["1.0.0", "1.2.0"]);
    // Markdown renders: bold becomes <strong>, a bullet list becomes <ul><li>.
    expect(host.querySelector(".settings__changelog-entry strong")).not.toBeNull();
    expect(host.querySelectorAll(".settings__changelog-entry li")).toHaveLength(2);
    expect(host.querySelector(".settings__changelog .form__label")!.textContent).toBe(
      "What's new",
    );
  });

  it("hides the changelog once the update is dismissed", async () => {
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "0.13.0", updater: true });
    mockCheck.mockResolvedValue({
      ...fakeUpdate("1.2.0"),
      changelog: [{ version: "1.2.0", notes: "notes" }],
    });
    await initUpdates(downloads);
    await render();
    expect(host.querySelector(".settings__changelog")).not.toBeNull();

    await act(async () => button("Dismiss").click());
    expect(host.querySelector(".settings__changelog")).toBeNull();
  });

  it("opens external changelog links in the browser and drops non-http ones", async () => {
    // The link override is the one place untrusted notes touch privileged
    // behavior: http(s) opens via openUrl; react-markdown strips javascript:
    // to "" so the gate never fires openUrl for it.
    mockInfo.mockResolvedValue({ name: "KeepDeck", version: "0.13.0", updater: true });
    mockCheck.mockResolvedValue({
      ...fakeUpdate("1.2.0"),
      changelog: [
        {
          version: "1.2.0",
          notes: "Read [the site](https://example.com) and skip [bad](javascript:alert(1))",
        },
      ],
    });
    await initUpdates(downloads);
    await render();

    const links = host.querySelectorAll<HTMLAnchorElement>(".settings__changelog-entry a");
    expect(links).toHaveLength(2);
    // react-markdown's default URL transform already neutralized javascript:.
    expect(links[0].getAttribute("href")).toBe("https://example.com");
    expect(links[1].getAttribute("href")).toBe("");

    await act(async () => links[0].click());
    expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com");

    mockOpenUrl.mockClear();
    await act(async () => links[1].click());
    expect(mockOpenUrl).not.toHaveBeenCalled();
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
