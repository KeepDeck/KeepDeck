import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../settings";
import type { Workspace } from "../deck";
import {
  dockPanel,
  dockToggle,
  paneRunShortcut,
  setupField,
} from "./criteria";

const off: Settings = { ...DEFAULT_SETTINGS, experimentRunPresets: false };
const on: Settings = { ...DEFAULT_SETTINGS, experimentRunPresets: true };
const ws: Workspace = {
  id: "ws-1",
  name: "app",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
};

describe("run criteria — every surface is one named declaration", () => {
  it("every surface is hidden while the experiment is off (or settings not loaded)", () => {
    for (const settings of [off, null]) {
      expect(dockToggle.satisfiedBy({ settings })).toBe(false);
      expect(paneRunShortcut.satisfiedBy({ settings })).toBe(false);
      expect(
        dockPanel.satisfiedBy({ settings, dockOpen: true, activeWorkspace: ws }),
      ).toBe(false);
      expect(setupField.satisfiedBy({ settings, worktreeDir: "/wt" })).toBe(false);
    }
  });

  it("the flag alone reveals the toggle and the pane shortcut", () => {
    expect(dockToggle.satisfiedBy({ settings: on })).toBe(true);
    expect(paneRunShortcut.satisfiedBy({ settings: on })).toBe(true);
  });

  it("the dock panel needs the flag AND the toggle AND a workspace", () => {
    const ctx = { settings: on, dockOpen: true, activeWorkspace: ws };
    expect(dockPanel.satisfiedBy(ctx)).toBe(true);
    expect(dockPanel.satisfiedBy({ ...ctx, dockOpen: false })).toBe(false);
    expect(dockPanel.satisfiedBy({ ...ctx, activeWorkspace: null })).toBe(false);
  });

  it("the setup field additionally needs worktrees in play", () => {
    expect(setupField.satisfiedBy({ settings: on, worktreeDir: "/wt" })).toBe(true);
    expect(setupField.satisfiedBy({ settings: on, worktreeDir: "   " })).toBe(false);
    expect(setupField.satisfiedBy({ settings: on, worktreeDir: "" })).toBe(false);
  });
});
