import { describe, expect, it } from "vitest";
import type {
  AgentContribution,
  PluginContext,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import plugin from "./index";

/** Activate against a minimal fake ctx; returns the registered agent. */
function activate(reporterPath: string | null): AgentContribution {
  let agent: AgentContribution | undefined;
  plugin.activate({
    agents: { register: (a: AgentContribution) => ((agent = a), { dispose() {} }) },
    resources: { path: async () => reporterPath },
  } as unknown as PluginContext);
  if (!agent) throw new Error("plugin registered no agent");
  return agent;
}

const output = (): SpawnPlanOutput => ({
  command: "opencode",
  args: [],
  env: [],
});

const input = { paneId: "pane-3", wsId: "ws-1", cwd: "/repo" };

describe("opencode plugin hooks", () => {
  it("injects the reporter via a MERGING per-invocation config", async () => {
    const agent = activate("/App/resources/session-reporter.js");
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(out.args).toEqual([]);
    const env = Object.fromEntries(out.env);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      plugin: ["/App/resources/session-reporter.js"],
    });
  });

  it("resumes with -s and still arms the reporter (catches /new)", async () => {
    const agent = activate("/App/resources/session-reporter.js");
    const out = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "ses_x" }, out);

    expect(out.args).toEqual(["-s", "ses_x"]);
    expect(Object.fromEntries(out.env).OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it("degrades to a bare spawn when the reporter is missing", async () => {
    const agent = activate(null);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);
    expect(out.env).toEqual([]);
    expect(out.args).toEqual([]);
  });
});

describe("opencode plugin identity", () => {
  it("ships the monochrome brand mark (the official frame + block cursor)", () => {
    const agent = activate(null);
    expect(agent.icon?.viewBox).toBe("0 0 256 320");
    expect(agent.icon?.path).toBeTruthy();
    expect(agent.icon?.color).toBeUndefined();
    expect(agent.icon?.fillRule).toBe("evenodd");
  });
});
