// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentsIpc,
  blur,
  button,
  findButton,
  DEFAULT_SETTINGS,
  dialogHost,
  getSettings,
  ipc,
  DIALOG_LOAD_TIMEOUT_MS,
  loadSettingsDialog,
  mountDialog,
  panelOf,
  resetSettingsManager,
  SCROLLBACK_MIN,
  scrollbackInput,
  type,
  type Settings,
} from "./testSupport";
import { present } from "@keepdeck/plugin-api/testing";

describe("SettingsDialog", () => {
  // The dialog's cold module load is the suite's, not the first test's.
  beforeAll(() => loadSettingsDialog(), DIALOG_LOAD_TIMEOUT_MS);

  let root: Root;
  let closed: number;

  beforeEach(() => {
    root = dialogHost();
    closed = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    resetSettingsManager();
  });

  const mount = (
    overrides: Partial<Settings> = {},
    initialSectionId?: string,
  ) => mountDialog(root, () => closed++, overrides, initialSectionId);

  const toTerminal = () => act(() => button("Terminal").click());

  it("opens on General; the nav switches which panel is visible", async () => {
    await mount();
    expect(panelOf(button("Claude Code")).hasAttribute("hidden")).toBe(false);
    expect(panelOf(present(scrollbackInput(), "terminal scrollback input")).hasAttribute("hidden")).toBe(true);
    expect(button("General").className).toContain("settings__nav-item--active");

    toTerminal();
    expect(panelOf(present(scrollbackInput(), "terminal scrollback input")).hasAttribute("hidden")).toBe(false);
    expect(panelOf(button("Claude Code")).hasAttribute("hidden")).toBe(true);
    expect(button("Terminal").className).toContain(
      "settings__nav-item--active",
    );
  });

  it("switching sections never refetches the agent catalog", async () => {
    // A remount would refetch and flash the General panel empty while the
    // IPC roundtrip runs — panels must stay mounted across switches.
    await mount();
    agentsIpc.detectBins.mockClear();
    toTerminal();
    act(() => button("General").click());
    expect(agentsIpc.detectBins).not.toHaveBeenCalled();
  });

  it("keeps observational usage statistics out of settings", async () => {
    await mount();
    const labels = [...document.querySelectorAll(".settings__nav-item")].map(
      (entry) => entry.textContent,
    );
    expect(labels).not.toContain("Stats");
    expect(findButton("24h")).toBeUndefined();
  });

  it("an uncommitted scrollback draft survives a section round-trip", async () => {
    await mount();
    toTerminal();
    type(present(scrollbackInput(), "terminal scrollback input"), "7");
    act(() => button("General").click());
    toTerminal();
    expect(present(scrollbackInput(), "terminal scrollback input").value).toBe("7");
    // Still a draft — leaving the section is not a commit.
    expect(getSettings()?.scrollback).toBe(DEFAULT_SETTINGS.scrollback);
  });

  it("picking an agent writes the default through to the store", async () => {
    await mount({ defaultAgent: "codex" });
    act(() => button("Claude Code").click());
    expect(getSettings()?.defaultAgent).toBe("claude");
    // The active mark follows the store, not local state.
    expect(button("Claude Code").className).toContain("form__type--active");
  });

  it("marks the active choice", async () => {
    await mount({ defaultAgent: "codex" });
    expect(button("Codex").className).toContain("form__type--active");
    expect(button("Claude Code").className).not.toContain("form__type--active");
  });

  it("switching the YOLO default writes it through to the store", async () => {
    await mount();
    // Scoped to its own picker group — other sections have On/Off pairs too.
    const label = present(Array.from(document.querySelectorAll(".form__label")).find(
      (el) => el.textContent === "YOLO mode",
    ), "settings label \"YOLO mode\"");
    const on = present(Array.from(present(label.nextElementSibling, "choice buttons beside settings label").querySelectorAll("button")).find(
      (b) => b.textContent === "On",
    ), "button \"On\"");
    act(() => on.click());
    expect(getSettings()?.defaultYolo).toBe(true);
    expect(on.className).toContain("form__type--active");
  });

  it("toggles the remote-agents experiment from the Experimental section", async () => {
    await mount(); // remoteAgents defaults to false
    const label = present(Array.from(document.querySelectorAll(".form__label")).find(
      (el) => el.textContent === "Remote agents",
    ), "settings label \"Remote agents\"");
    expect(label, "Experimental → Remote agents row rendered").toBeTruthy();
    const on = present(Array.from(present(label.nextElementSibling, "choice buttons beside settings label").querySelectorAll("button")).find(
      (b) => b.textContent === "On",
    ), "button \"On\"");
    act(() => on.click());
    expect(getSettings()?.remoteAgents).toBe(true);
    expect(on.className).toContain("form__type--active");
  });

  it("scrollback commits clamped on blur — not per keystroke", async () => {
    await mount();
    toTerminal();
    type(present(scrollbackInput(), "terminal scrollback input"), "7");
    expect(getSettings()?.scrollback).toBe(DEFAULT_SETTINGS.scrollback); // still typing
    blur(present(scrollbackInput(), "terminal scrollback input"));
    expect(getSettings()?.scrollback).toBe(SCROLLBACK_MIN);
    expect(present(scrollbackInput(), "terminal scrollback input").value).toBe(String(SCROLLBACK_MIN));
  });

  it("a non-number reverts to the live value instead of writing", async () => {
    await mount();
    toTerminal();
    type(present(scrollbackInput(), "terminal scrollback input"), "lots");
    blur(present(scrollbackInput(), "terminal scrollback input"));
    expect(getSettings()?.scrollback).toBe(DEFAULT_SETTINGS.scrollback);
    expect(present(scrollbackInput(), "terminal scrollback input").value).toBe(String(DEFAULT_SETTINGS.scrollback));
  });

  it("an unchanged commit writes nothing", async () => {
    await mount();
    toTerminal();
    blur(present(scrollbackInput(), "terminal scrollback input"));
    expect(ipc.saveSettings).not.toHaveBeenCalled();
  });

  it("the ✕ and Escape only dismiss; instant-apply needs no Done footer", async () => {
    await mount();
    expect(findButton("Done")).toBeUndefined();
    expect(document.querySelector(".confirm__actions")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close settings",
    );
    act(() =>
      present(document
        .querySelector<HTMLButtonElement>('[aria-label="Close settings"]'), "element '[aria-label=\"Close settings\"]'")
        .click(),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(2);
    expect(ipc.saveSettings).not.toHaveBeenCalled();
  });
});
