// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentContribution, CwdArm, SpawnArmOutput } from "@keepdeck/plugin-api";
import { buildForkSpec, buildLivePaneSpec, buildResumeSpec, dropPaneSpawnSpec } from ".";
import {
  adopting,
  armCwd,
  armState,
  ctx,
  mcpAccess,
  planHarness,
  plugins,
  skillsState,
  stagedSkills,
  W1,
  ws,
} from "./planTestSupport";

/**
 * What an agent's plugin plants in a pane's cwd (`arm.plan`) through the
 * plan: asked once a plan exists and is kept, for every launch that produced
 * one, and handed to the arming port whole. The rest of the build is
 * `plan.test.ts`; the harness is shared.
 */
describe("cwd plantings through the plan", () => {
  const h = planHarness();
  beforeEach(() => h.reset());
  afterEach(() => h.teardown());

  const planted: CwdArm[] = [{ kind: "file", path: ".agent/conf.json", content: "{}" }];
  const arming = (over: Partial<AgentContribution["hooks"]> = {}): AgentContribution => ({
    ...adopting,
    hooks: {
      ...adopting.hooks,
      "fork.plan": (_input, output) => {
        output.args = ["--fork"];
      },
      "arm.plan": (_input, output: SpawnArmOutput) => {
        output.cwd.push(...planted);
      },
      ...over,
    },
  });
  const facts = { paneId: "pane-9", workspace: W1, cwd: "/repo", stagedSkills, mcpAccess, armCwd };

  it("plants what the plugin declares for a spawn, as one complete set for that cwd", async () => {
    skillsState.views = {
      claudePluginDir: "/c",
      opencodeConfigDir: "/o",
      skillsDir: "/s",
      dir: "/staged/skills",
      skills: [{ name: "a", content: "---\ndescription: A\n---\n" }],
    };
    h.register(arming());
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    expect(armState.calls).toEqual([
      [
        "claude",
        { pluginId: "test-plugin", workspaceId: "ws-1", cwd: "/repo", arms: planted, skillsDir: "/staged/skills" },
      ],
    ]);
  });

  it("plants for a resume and a fork that produced a plan", async () => {
    h.register(arming());
    await buildResumeSpec(plugins, "claude", facts, ctx, "old-id", "restore");
    dropPaneSpawnSpec("pane-9");
    await buildForkSpec(plugins, "claude", facts, ctx, { sessionId: "src", sourceCwd: "/elsewhere" });
    expect(armState.calls.map(([, request]) => request.arms)).toEqual([planted, planted]);
  });

  it("plants for the bare launch a throwing spawn.plan degrades to", async () => {
    h.register(
      arming({
        "spawn.plan": () => {
          throw new Error("plan broke");
        },
      }),
    );
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    expect(armState.calls).toHaveLength(1);
  });

  it("plants NOTHING for a resume whose hook rejected the plan", async () => {
    h.register(
      arming({
        "resume.plan": () => {
          throw new Error("no such session");
        },
      }),
    );
    await expect(buildResumeSpec(plugins, "claude", facts, ctx, "old-id", "restore")).rejects.toThrow();
    expect(armState.calls).toEqual([]);
  });

  it("never plants for a remote pane — its agent's directory is on the remote host", async () => {
    h.register(arming());
    await h.mount(
      ws([{ id: "pane-1", agentType: "claude", location: { kind: "remote", endpoint: "ws://vps:4500" } }]),
    );
    expect(armState.calls).toEqual([]);
  });

  it("leaves the cwd as it was when the hook throws — nothing new, nothing taken back", async () => {
    h.register(
      arming({
        "arm.plan": () => {
          throw new Error("arm broke");
        },
      }),
    );
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    expect(armState.calls).toEqual([]);
  });

  it("asks nothing of an agent that declares no plantings", async () => {
    h.register(adopting);
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    expect(armState.calls).toEqual([]);
  });

  it("hands over an empty set too — it takes back what an earlier launch planted", async () => {
    h.register(arming({ "arm.plan": () => {} }));
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    expect(armState.calls.map(([, request]) => request.arms)).toEqual([[]]);
  });

  it("plants only once the plan is kept — a build dropped mid-flight plants nothing", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.register(arming({ "spawn.plan": async () => held }));
    const workspaces = ws([{ id: "pane-1", agentType: "claude" }]);
    const building = buildLivePaneSpec(plugins, workspaces[0], workspaces[0].panes[0], ctx, {
      stagedSkills,
      mcpAccess,
      armCwd,
    });
    dropPaneSpawnSpec("pane-1");
    release();
    expect(await building).toBe(false);
    expect(armState.calls).toEqual([]);
  });
});
