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

const input = {
  paneId: "pane-2",
  workspace: { id: "ws-1", instance: "workspace-instance-1" },
  cwd: "/repo",
};

describe("codex plugin hooks", () => {
  it("arms the SessionStart hook via -c overrides, id NOT adopted", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    // 4 hook args + 2 paste-burst override args.
    expect(out.args).toHaveLength(6);
    expect(out.args[0]).toBe("-c");
    expect(out.args[1]).toContain(
      `command="/bin/sh '/App/resources/kd-session-hook.sh'"`,
    );
    expect(out.args[3]).toContain("trusted_hash");
    expect(out.args).toContain("disable_paste_burst=true");
  });

  it("disables paste-burst on every spawn path, before the subcommand", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");

    const spawn = output();
    await agent.hooks["spawn.plan"]!(input, spawn);
    expect(spawn.args).toContain("disable_paste_burst=true");

    const resume = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "uuid-9" }, resume);
    expect(resume.args).toContain("disable_paste_burst=true");
    // The override precedes the `resume` subcommand (it is a global `-c`).
    expect(resume.args.indexOf("disable_paste_burst=true")).toBeLessThan(
      resume.args.indexOf("resume"),
    );

    const fork = output();
    await agent.hooks["fork.plan"]!(
      { ...input, sessionId: "uuid-9", sourceCwd: "/x" },
      fork,
    );
    expect(fork.args).toContain("disable_paste_burst=true");
    expect(fork.args.indexOf("disable_paste_burst=true")).toBeLessThan(
      fork.args.indexOf("fork"),
    );
  });

  it("puts the global -c flags BEFORE the resume subcommand", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "uuid-9" }, out);

    expect(out.args.slice(0, 1)).toEqual(["-c"]);
    expect(out.args.slice(-2)).toEqual(["resume", "uuid-9"]);
  });

  it("fork.plan is args-only: global flags, then the fork subcommand", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await agent.hooks["fork.plan"]!(
      { ...input, sessionId: "uuid-9", sourceCwd: "/somewhere/else" },
      out,
    );

    // No surgery, no sourceCwd use — codex resolves the id globally.
    expect(out.args.slice(0, 1)).toEqual(["-c"]);
    expect(out.args.slice(-2)).toEqual(["fork", "uuid-9"]);

    const yolo = output();
    await agent.hooks["fork.plan"]!(
      { ...input, yolo: true, sessionId: "u", sourceCwd: "/x" },
      yolo,
    );
    expect(yolo.args.slice(0, 1)).toEqual(["-c"]);
    expect(yolo.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("drops the hook when the script is missing; the paste-burst override still applies", async () => {
    const agent = activate(null);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);
    expect(out.args).toEqual(["-c", "disable_paste_burst=true"]);
    expect(out.args.join(" ")).not.toContain("trusted_hash");

    const resume = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "x" }, resume);
    expect(resume.args).toEqual([
      "-c",
      "disable_paste_burst=true",
      "resume",
      "x",
    ]);
  });

  it("YOLO adds the global bypass flag, BEFORE the resume subcommand", async () => {
    const agent = activate(null);
    expect(agent.supportsYolo).toBe(true);

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, yolo: true }, spawn);
    expect(spawn.args).toEqual([
      "-c",
      "disable_paste_burst=true",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);

    const resume = output();
    await agent.hooks["resume.plan"]!(
      { ...input, yolo: true, sessionId: "uuid-9" },
      resume,
    );
    expect(resume.args).toEqual([
      "-c",
      "disable_paste_burst=true",
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "uuid-9",
    ]);
  });

  it("declares nativeServer remote support", () => {
    expect(activate(null).remote?.mode).toBe("nativeServer");
  });

  it("prepends `--remote <ep>` (before globals and subcommand) on a nativeServer target", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const target = { kind: "nativeServer" as const, endpoint: "ws://vps:4500" };

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, target }, spawn);
    expect(spawn.args.slice(0, 2)).toEqual(["--remote", "ws://vps:4500"]);
    // globals (-c) still land after --remote, before any subcommand
    expect(spawn.args[2]).toBe("-c");

    const resume = output();
    await agent.hooks["resume.plan"]!(
      { ...input, target, sessionId: "uuid-9" },
      resume,
    );
    expect(resume.args.slice(0, 2)).toEqual(["--remote", "ws://vps:4500"]);
    expect(resume.args.slice(-2)).toEqual(["resume", "uuid-9"]);

    const fork = output();
    await agent.hooks["fork.plan"]!(
      { ...input, target, sessionId: "uuid-9", sourceCwd: "/x" },
      fork,
    );
    expect(fork.args.slice(0, 2)).toEqual(["--remote", "ws://vps:4500"]);
    expect(fork.args.slice(-2)).toEqual(["fork", "uuid-9"]);
  });

  it("emits no --remote without a target (local pane unchanged)", async () => {
    const agent = activate(null);
    const spawn = output();
    await agent.hooks["spawn.plan"]!(input, spawn);
    expect(spawn.args.some((a) => a === "--remote")).toBe(false);
  });

  it("combines --remote and YOLO on a fresh spawn (order: remote, then bypass)", async () => {
    // Security-adjacent: a reorder must not silently drop --remote (which
    // would run locally) nor the bypass flag (approvals on the remote server).
    const agent = activate(null);
    const target = { kind: "nativeServer" as const, endpoint: "ws://vps:4500" };
    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, target, yolo: true }, spawn);
    expect(spawn.args).toEqual([
      "--remote",
      "ws://vps:4500",
      // main's PasteBurst-disable -c rides every codex spawn (global, before
      // the subcommand) — present on remote spawns too.
      "-c",
      "disable_paste_burst=true",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);

    const resume = output();
    await agent.hooks["resume.plan"]!(
      { ...input, target, yolo: true, sessionId: "uuid-9" },
      resume,
    );
    expect(resume.args).toEqual([
      "--remote",
      "ws://vps:4500",
      "-c",
      "disable_paste_burst=true",
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

  it("declares the shared app-server account-limits source", () => {
    const agent = activate(null);
    expect(agent.usage?.tail).toBe("codex");
    expect(agent.usage?.limits?.poll).toBe("codex-app-server");
  });
});
