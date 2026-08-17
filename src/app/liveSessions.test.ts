import { describe, expect, it, vi } from "vitest";
import * as liveSessionsSeam from "./liveSessions";
import type { AgentContribution } from "@keepdeck/plugin-api";
import {
  askBackgroundCarriers,
  askLiveRegistry,
  liveOutsideSessions,
} from "./liveSessions";
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

describe("askBackgroundCarriers — the seam's one entry, single-entry cases", () => {
  it("a row holding the session with kind background is THE carrier answer", async () => {
    // The registry answers with the CONVERSATION's id on the carrier's
    // row — the close-flow question is a row lookup, not a join.
    const carried = pluginsWith({
      list: async () => [
        { sessionId: "s-1", kind: "background" },
        { sessionId: "s-2", kind: "interactive" },
      ],
    });
    await expect(
      askBackgroundCarriers(carried, [{ agentType: "claude", sessionId: "s-1" }]),
    ).resolves.toEqual(["background"]);
    // A pane holding its own INTERACTIVE row is not carried — the work
    // lives in this pane, and an ordinary close ends it.
    await expect(
      askBackgroundCarriers(carried, [{ agentType: "claude", sessionId: "s-2" }]),
    ).resolves.toEqual(["none"]);
    await expect(
      askBackgroundCarriers(carried, [{ agentType: "claude", sessionId: "s-3" }]),
    ).resolves.toEqual(["none"]);
  });

  it("no capability is null, never none — a question never asked is not an answer", async () => {
    // The C1 line, load-bearing here too: only the registry's own CLAIM
    // of "not carried" may read as "none". An agent without the
    // capability answers null for its entries — the batch must not
    // launder that into an assertion.
    await expect(
      askBackgroundCarriers(pluginsWith(), [
        { agentType: "claude", sessionId: "s" },
      ]),
    ).resolves.toEqual([null]);
    const broken = pluginsWith({
      list: async () => {
        throw new Error("agents --json exited with 2");
      },
    });
    await expect(
      askBackgroundCarriers(broken, [{ agentType: "claude", sessionId: "s" }]),
    ).resolves.toEqual(["unknown"]);
  });

  it("the seam exports no single-entry twin — one entry, one path", async () => {
    // The dead-surface rule, applied to ourselves: an exported helper no
    // production caller invokes is exactly what this step demolished
    // elsewhere. The singular form once lived here; its return would be a
    // regression of that rule, pinned by its absence.
    expect("askBackgroundCarrier" in liveSessionsSeam).toBe(false);
  });
});

describe("askBackgroundCarriers (the batch a workspace close asks with)", () => {
  it("ONE registry query per distinct agent, answers aligned to entries", async () => {
    // N panes of one CLI must cost one spawn, not N — a workspace close
    // would otherwise fan out a CLI army per pane.
    const list = vi.fn(async () => [
      { sessionId: "s-1", kind: "background" },
      { sessionId: "s-2", kind: "interactive" },
    ]);
    const live = pluginsWith({ list });
    const answers = await askBackgroundCarriers(live, [
      { agentType: "claude", sessionId: "s-1" },
      { agentType: "claude", sessionId: "s-2" },
      { agentType: "claude", sessionId: "s-3" },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(answers).toEqual(["background", "none", "none"]);
  });

  it("a refusing agent answers unknown for ITS entries only — the others keep their truth", async () => {
    const plugins = {
      pluginRegistries: {
        agents: {
          list: () => [
            {
              entry: {
                id: "claude",
                liveSessions: {
                  list: async () => {
                    throw new Error("daemon down");
                  },
                },
              },
              pluginId: "p",
            },
            {
              entry: {
                id: "codex",
                liveSessions: {
                  list: async () => [{ sessionId: "c-1", kind: "background" }],
                },
              },
              pluginId: "p",
            },
          ],
        },
      },
    } as unknown as SpawnPluginAccess;
    const answers = await askBackgroundCarriers(plugins, [
      { agentType: "claude", sessionId: "s-1" },
      { agentType: "codex", sessionId: "c-1" },
    ]);
    expect(answers).toEqual(["unknown", "background"]);
  });
});
