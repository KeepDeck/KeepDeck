import { describe, expect, it } from "vitest";
import type {
  AgentContribution,
  PluginContext,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import plugin from "./index";

/** Activate against a minimal fake ctx; returns the registered agent.
 * `resources` maps script name → resolved path (missing name = null), so a
 * test can arm the two reporters independently. */
function activate(
  resources: Record<string, string> | null,
  copies: [string, string][] = [],
): AgentContribution {
  let agent: AgentContribution | undefined;
  plugin.activate({
    agents: { register: (a: AgentContribution) => ((agent = a), { dispose() {} }) },
    resources: { path: async (name: string) => resources?.[name] ?? null },
    services: {
      fsWrite: {
        copyFile: async (src: string, dst: string) => {
          copies.push([src, dst]);
        },
      },
    },
  } as unknown as PluginContext);
  if (!agent) throw new Error("plugin registered no agent");
  return agent;
}

const SESSION_HOOK = {
  "kd-session-hook.sh": "/App/resources/kd-session-hook.sh",
};
const USAGE_HOOK = {
  "kd-usage-statusline.sh": "/App/resources/kd-usage-statusline.sh",
};

const output = (): SpawnPlanOutput => ({
  command: "claude",
  args: [],
  env: [],
});

const input = {
  paneId: "pane-1",
  workspace: { id: "ws-1", instance: "workspace-instance-1" },
  cwd: "/repo",
};

describe("claude plugin hooks", () => {
  it("arms the SessionStart reporter — identity is reporter-based", async () => {
    const agent = activate(SESSION_HOOK);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(out.args[0]).toBe("--settings");
    const settings = JSON.parse(out.args[1]);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      "/bin/sh '/App/resources/kd-session-hook.sh'",
    );
    // No usage script resolved → no statusLine override rides along.
    expect(settings.statusLine).toBeUndefined();
    // No --session-id: claude mints its own id; the hook posts it back.
    expect(out.args).toHaveLength(2);
  });

  it("arms the statusLine usage reporter alongside identity", async () => {
    const agent = activate({ ...SESSION_HOOK, ...USAGE_HOOK });
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    const settings = JSON.parse(out.args[1]);
    expect(settings.statusLine).toEqual({
      type: "command",
      command: "/bin/sh '/App/resources/kd-usage-statusline.sh'",
      refreshInterval: 60,
    });
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      "kd-session-hook.sh",
    );
  });

  it("each reporter degrades independently when its script is missing", async () => {
    const agent = activate(USAGE_HOOK);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    const settings = JSON.parse(out.args[1]);
    expect(settings.hooks).toBeUndefined();
    expect(settings.statusLine.command).toContain("kd-usage-statusline.sh");
  });

  it("staged skills load as a local plugin via --plugin-dir", async () => {
    const agent = activate(SESSION_HOOK);
    const skills = {
      claudePluginDir: "/kd/staging/ws-1/claude-plugin",
      opencodeConfigDir: "/kd/staging/ws-1/opencode",
      skillsDir: "/kd/staging/ws-1/skills",
    };

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, skills }, spawn);
    expect(spawn.args.slice(2)).toEqual([
      "--plugin-dir",
      "/kd/staging/ws-1/claude-plugin",
    ]);

    const resume = output();
    await agent.hooks["resume.plan"]!({ ...input, skills, sessionId: "s" }, resume);
    expect(resume.args.slice(2)).toEqual([
      "--plugin-dir",
      "/kd/staging/ws-1/claude-plugin",
      "--resume",
      "s",
    ]);

    // No skills staged — the flag must not appear at all.
    const bare = output();
    await agent.hooks["spawn.plan"]!(input, bare);
    expect(bare.args).not.toContain("--plugin-dir");
  });

  it("resume reuses the recorded id and keeps the reporter armed", async () => {
    const agent = activate(SESSION_HOOK);
    const out = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "old-id" }, out);

    expect(out.args[0]).toBe("--settings");
    expect(out.args.slice(2)).toEqual(["--resume", "old-id"]);
  });

  it("degrades to a bare spawn when both reporter scripts are missing", async () => {
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

describe("claude fork.plan", () => {
  const forkInput = {
    ...input,
    sessionId: "uuid-1",
    sourceCwd: "/old/worktree",
    transcriptPath:
      "/Users/u/.claude/projects/-old-worktree/uuid-1.jsonl",
  };

  it("copies the transcript into the target slug dir, then resumes with --fork-session", async () => {
    const copies: [string, string][] = [];
    const agent = activate(SESSION_HOOK, copies);
    const out = output();
    await agent.hooks["fork.plan"]!(
      { ...forkInput, cwd: "/repo/wt_2.x" },
      out,
    );

    // Slug: `/`, `.` and `_` each become `-`; the projects root comes from
    // the transcript path itself.
    expect(copies).toEqual([
      [
        "/Users/u/.claude/projects/-old-worktree/uuid-1.jsonl",
        "/Users/u/.claude/projects/-repo-wt-2-x/uuid-1.jsonl",
      ],
    ]);
    expect(out.args.slice(-3)).toEqual(["--resume", "uuid-1", "--fork-session"]);
  });

  it("rejects without a recorded transcript path — no guessing, no surgery", async () => {
    const copies: [string, string][] = [];
    const agent = activate(null, copies);
    await expect(
      agent.hooks["fork.plan"]!(
        { ...input, sessionId: "uuid-1", sourceCwd: "/x" },
        output(),
      ),
    ).rejects.toThrow("no recorded transcript path");
    expect(copies).toEqual([]);
  });

  it("rejects an unexpected store layout loudly instead of copying blind", async () => {
    const agent = activate(null);
    await expect(
      agent.hooks["fork.plan"]!(
        {
          ...input,
          sessionId: "u",
          sourceCwd: "/x",
          transcriptPath: "/somewhere/odd/u.jsonl",
        },
        output(),
      ),
    ).rejects.toThrow("unexpected store layout");
    await expect(
      agent.hooks["fork.plan"]!(
        {
          ...input,
          sessionId: "u",
          sourceCwd: "/x",
          transcriptPath: "/Users/u/.claude/projects/-x/u.txt",
        },
        output(),
      ),
    ).rejects.toThrow("not a .jsonl");
  });
});
