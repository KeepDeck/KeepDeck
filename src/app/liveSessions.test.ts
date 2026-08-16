import { describe, expect, it } from "vitest";
import type { AgentContribution } from "@keepdeck/plugin-api";
import { askLiveRegistry, liveOutsideSessions } from "./liveSessions";
import type { SpawnPluginAccess } from "./spawnSpecs";

const pluginsWith = (
  live?: AgentContribution["liveSessions"],
): SpawnPluginAccess =>
  ({
    pluginRegistries: {
      agents: {
        list: () => [
          { entry: { id: "claude", liveSessions: live }, pluginId: "p" },
        ],
      },
    },
  }) as unknown as SpawnPluginAccess;

describe("askLiveRegistry", () => {
  it("no capability to ask is its own answer — null, never 'absent'", async () => {
    await expect(askLiveRegistry(pluginsWith(), "claude", "s")).resolves.toBe(
      null,
    );
    await expect(
      askLiveRegistry(pluginsWith({ list: async () => [] }), "codex", "s"),
    ).resolves.toBe(null);
  });

  it("a row with the session id is LIVE; its absence from the list is ABSENT", async () => {
    const live = pluginsWith({
      list: async () => [{ sessionId: "s-1", kind: "background" }],
    });
    await expect(askLiveRegistry(live, "claude", "s-1")).resolves.toBe("live");
    await expect(askLiveRegistry(live, "claude", "s-2")).resolves.toBe(
      "absent",
    );
  });

  it("a refusing registry is UNKNOWN — the caller reads it like live", async () => {
    const broken = pluginsWith({
      list: async () => {
        throw new Error("agents --json exited with 2");
      },
    });
    await expect(askLiveRegistry(broken, "claude", "s-1")).resolves.toBe(
      "unknown",
    );
  });
});

describe("liveOutsideSessions", () => {
  it("hands the picker the live ids; a refusal is ok:false, never a made-up empty set", async () => {
    const live = pluginsWith({
      list: async () => [
        { sessionId: "s-1", kind: "background" },
        { sessionId: "s-2", kind: "interactive" },
      ],
    });
    await expect(liveOutsideSessions(live, "claude")).resolves.toEqual({
      ok: true,
      ids: new Set(["s-1", "s-2"]),
    });

    const broken = pluginsWith({
      list: async () => {
        throw new Error("daemon down");
      },
    });
    await expect(liveOutsideSessions(broken, "claude")).resolves.toEqual({
      ok: false,
    });
  });
});
