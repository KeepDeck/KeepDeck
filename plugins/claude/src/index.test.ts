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
  sessionId: null,
});

const input = {
  paneId: "pane-1",
  wsId: "ws-1",
  cwd: "/repo",
  sessionId: "11111111-2222-3333-4444-555555555555",
};

describe("claude plugin hooks", () => {
  it("assigns the pre-minted id and arms the /clear reporter", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(out.args[0]).toBe("--settings");
    const settings = JSON.parse(out.args[1]);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      "/bin/sh '/App/resources/kd-session-hook.sh'",
    );
    expect(out.args.slice(2)).toEqual(["--session-id", input.sessionId]);
    // Adopted: the host binds immediately, no discovery.
    expect(out.sessionId).toBe(input.sessionId);
  });

  it("resume reuses the recorded id and keeps the reporter armed", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "old-id" }, out);

    expect(out.args[0]).toBe("--settings");
    expect(out.args.slice(2)).toEqual(["--resume", "old-id"]);
    expect(out.sessionId).toBeNull(); // the binding is already recorded
  });

  it("degrades to assignment-only when the reporter script is missing", async () => {
    const agent = activate(null);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(out.args).toEqual(["--session-id", input.sessionId]);
    expect(out.sessionId).toBe(input.sessionId);
  });
});
