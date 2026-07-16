import { describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@keepdeck/plugin-api";
import {
  applyBuiltinDownloadMigrations,
  hasBuiltinOnlyDownloadMigrations,
} from "./pluginMigrations";

vi.mock("../ipc/downloads", () => ({ adoptPluginDownloads: vi.fn(async () => {}) }));
import { adoptPluginDownloads } from "../ipc/downloads";

const manifest: PluginManifest = {
  id: "keepdeck.voice",
  name: "Voice",
  version: "1.0.0",
  minApiVersion: 18,
  category: "deck",
  capabilities: [
    {
      kind: "legacyDownloads",
      migrations: [
        { source: "models", target: "models", stripSingleRoots: true },
      ],
    },
  ],
  contributes: {},
};

describe("plugin download migrations", () => {
  it("runs bundled migrations before activation through the internal port", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await applyBuiltinDownloadMigrations(manifest, log);
    expect(adoptPluginDownloads).toHaveBeenCalledWith(
      "keepdeck.voice",
      manifest.capabilities[0].kind === "legacyDownloads"
        ? manifest.capabilities[0].migrations[0]
        : null,
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("marks this manifest feature as bundled-only", () => {
    expect(hasBuiltinOnlyDownloadMigrations(manifest)).toBe(true);
    expect(
      hasBuiltinOnlyDownloadMigrations({ ...manifest, capabilities: [] }),
    ).toBe(false);
  });
});
