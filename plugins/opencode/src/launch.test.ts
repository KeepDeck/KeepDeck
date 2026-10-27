import { describe, expect, it } from "vitest";
import type { SpawnPlanOutput } from "@keepdeck/plugin-api";
import { composed, render, type LaunchDraft, type OpencodeLaunch } from "./launch";

const draft = (): LaunchDraft => ({ config: {}, env: [], envDefaults: [], args: [] });

describe("a composed launch", () => {
  it("runs its parts in order, each after the last one finished", async () => {
    // Order is the arguments' order, and a part may await (the warm-up):
    // starting the next before it ends would interleave what they push.
    const slow: OpencodeLaunch = {
      async prepare(_input, d) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        d.args.push("first");
      },
    };
    const fast: OpencodeLaunch = {
      async prepare(_input, d) {
        d.args.push("second");
      },
    };
    const d = draft();
    await composed(slow, fast).prepare({ workspace: { id: "ws-1", instance: "i-1" } }, d);
    expect(d.args).toEqual(["first", "second"]);
  });
});

describe("rendering a launch", () => {
  const out = (): SpawnPlanOutput => ({ command: "opencode", args: [], env: [] });

  it("puts the whole config in ONE variable, ahead of the rest of the environment", () => {
    const d = draft();
    d.config.plugin = ["/p"];
    d.config.mcp = { s: {} };
    d.env.push(["KEEPDECK_OPENCODE_SKIPS_APPROVALS", "1"]);
    const o = out();
    render(d, o);
    expect(o.env).toEqual([
      ["OPENCODE_CONFIG_CONTENT", JSON.stringify({ plugin: ["/p"], mcp: { s: {} } })],
      ["KEEPDECK_OPENCODE_SKIPS_APPROVALS", "1"],
    ]);
  });

  it("sets no config variable when nothing went into the config", () => {
    // An empty one would still override whatever the user's environment
    // carries under that name.
    const o = out();
    render(draft(), o);
    expect(o.env).toEqual([]);
    expect(o.envDefaults).toEqual([]);
  });
});
