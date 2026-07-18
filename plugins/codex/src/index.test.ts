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
  command: "codex",
  args: [],
  env: [],
});

const input = { paneId: "pane-2", wsId: "ws-1", cwd: "/repo" };

describe("codex plugin hooks", () => {
  it("arms the SessionStart hook via -c overrides, id NOT adopted", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(out.args).toHaveLength(4);
    expect(out.args[0]).toBe("-c");
    expect(out.args[1]).toContain(
      `command="/bin/sh '/App/resources/kd-session-hook.sh'"`,
    );
    expect(out.args[3]).toContain("trusted_hash");
  });

  it("puts the global -c flags BEFORE the resume subcommand", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "uuid-9" }, out);

    expect(out.args.slice(0, 1)).toEqual(["-c"]);
    expect(out.args.slice(-2)).toEqual(["resume", "uuid-9"]);
  });

  it("degrades to a bare spawn when the script is missing", async () => {
    const agent = activate(null);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);
    expect(out.args).toEqual([]);

    const resume = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "x" }, resume);
    expect(resume.args).toEqual(["resume", "x"]);
  });

  it("YOLO adds the global bypass flag, BEFORE the resume subcommand", async () => {
    const agent = activate(null);
    expect(agent.supportsYolo).toBe(true);

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, yolo: true }, spawn);
    expect(spawn.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);

    const resume = output();
    await agent.hooks["resume.plan"]!(
      { ...input, yolo: true, sessionId: "uuid-9" },
      resume,
    );
    expect(resume.args).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "uuid-9",
    ]);
  });
});

describe("codex plugin identity", () => {
  it("ships the monochrome OpenAI mark, authored for evenodd", () => {
    const agent = activate(null);
    expect(agent.icon?.viewBox).toBe("0 0 24 24");
    expect(agent.icon?.paths).toHaveLength(1);
    expect(agent.icon?.paths[0].color).toBeUndefined();
    expect(agent.icon?.paths[0].fillRule).toBe("evenodd");
  });
});
