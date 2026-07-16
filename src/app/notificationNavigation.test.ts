import { describe, expect, it } from "vitest";
import { settingsSectionForNotification } from "./notificationNavigation";

describe("settingsSectionForNotification", () => {
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
        wsId: "ws-1",
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
        wsId: "ws-1",
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
          wsId: "gone-workspace",
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
