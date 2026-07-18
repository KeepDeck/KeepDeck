import { describe, expect, it } from "vitest";
import type {
  AgentContribution,
  PluginContext,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import plugin from "./index";

/** Activate against a minimal fake ctx; returns the registered agent. */
function activate(scriptPath: string | null): AgentContribution {
  let agent: AgentContribution | undefined;
  plugin.activate({
    agents: { register: (a: AgentContribution) => ((agent = a), { dispose() {} }) },
    resources: { path: async () => scriptPath },
  } as unknown as PluginContext);
  if (!agent) throw new Error("plugin registered no agent");
  return agent;
}

const output = (): SpawnPlanOutput => ({
  command: "claude",
  args: [],
  env: [],
});

const input = { paneId: "pane-1", wsId: "ws-1", cwd: "/repo" };

describe("claude plugin hooks", () => {
  it("arms the SessionStart reporter — identity is reporter-based", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(out.args[0]).toBe("--settings");
    const settings = JSON.parse(out.args[1]);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      "/bin/sh '/App/resources/kd-session-hook.sh'",
    );
    // No --session-id: claude mints its own id; the hook posts it back.
    expect(out.args).toHaveLength(2);
  });

  it("resume reuses the recorded id and keeps the reporter armed", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "old-id" }, out);

    expect(out.args[0]).toBe("--settings");
    expect(out.args.slice(2)).toEqual(["--resume", "old-id"]);
  });

  it("degrades to a bare spawn when the reporter script is missing", async () => {
    const agent = activate(null);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(out.args).toEqual([]);
  });

  it("YOLO adds the skip-permissions flag on spawn and resume alike", async () => {
    const agent = activate(null);
    expect(agent.supportsYolo).toBe(true);

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, yolo: true }, spawn);
    expect(spawn.args).toEqual(["--dangerously-skip-permissions"]);

    const resume = output();
    await agent.hooks["resume.plan"]!(
      { ...input, yolo: true, sessionId: "old-id" },
      resume,
    );
    expect(resume.args).toEqual([
      "--dangerously-skip-permissions",
      "--resume",
      "old-id",
    ]);
  });
});

describe("claude plugin identity", () => {
  it("ships the brand mark in Anthropic's tint", () => {
    const agent = activate(null);
    expect(agent.icon?.viewBox).toBe("0 0 24 24");
    expect(agent.icon?.paths).toHaveLength(1);
    expect(agent.icon?.paths[0].d).toBeTruthy();
    expect(agent.icon?.paths[0].color).toBe("#D97757");
  });
});
