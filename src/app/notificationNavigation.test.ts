import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import {
  settingsSectionForNotification,
  workspaceForNotification,
} from "./notificationNavigation";

describe("settingsSectionForNotification", () => {
  const instance = createWorkspaceInstance();
  it("opens an untargeted plugin notification on that plugin's settings", () => {
    expect(
      settingsSectionForNotification({
        type: "plugin",
        pluginId: "keepdeck.kimi",
      }),
    ).toBe("plugin:keepdeck.kimi");
  });

  it("leaves workspace, dock and pane targets to their precise navigation", () => {
    expect(
      settingsSectionForNotification({
        type: "plugin",
        pluginId: "keepdeck.git",
        workspace: { id: "ws-1", instance },
      }),
    ).toBeNull();
    expect(
      settingsSectionForNotification({
        type: "plugin",
        pluginId: "keepdeck.git",
        dockTab: "status",
      }),
    ).toBeNull();
    expect(
      settingsSectionForNotification({
        type: "pane",
        workspace: { id: "ws-1", instance },
        paneId: "pane-1",
      }),
    ).toBeNull();
  });

  it("falls back to plugin settings when a precise target is stale", () => {
    expect(
      settingsSectionForNotification(
        {
          type: "plugin",
          pluginId: "keepdeck.git",
          workspace: { id: "gone-workspace", instance: null },
        },
        false,
      ),
    ).toBe("plugin:keepdeck.git");
    expect(
      settingsSectionForNotification(
        {
          type: "plugin",
          pluginId: "keepdeck.git",
          dockTab: "gone-tab",
        },
        false,
      ),
    ).toBe("plugin:keepdeck.git");
  });

  it("keeps app notifications mapped to Updates", () => {
    expect(settingsSectionForNotification({ type: "app" })).toBe("updates");
  });
});

describe("workspaceForNotification", () => {
  it("rejects an old lifetime after the public id is reused", () => {
    const oldInstance = createWorkspaceInstance();
    const current = {
      id: "ws-3",
      instance: createWorkspaceInstance(),
      name: "new",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [],
    };

    expect(
      workspaceForNotification([current], {
        id: "ws-3",
        instance: oldInstance,
      }),
    ).toBeNull();
    expect(
      workspaceForNotification([current], {
        id: "ws-3",
        instance: current.instance,
      }),
    ).toBe(current);
  });

  it("never attaches an unresolved plugin target to a future workspace", () => {
    const current = {
      id: "ws-3",
      instance: createWorkspaceInstance(),
      name: "new",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [],
    };
    expect(
      workspaceForNotification([current], { id: "ws-3", instance: null }),
    ).toBeNull();
  });
});
