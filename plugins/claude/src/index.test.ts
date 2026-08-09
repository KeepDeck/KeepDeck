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
const STATUS_HOOK = {
  "kd-status-hook.sh": "/App/resources/kd-status-hook.sh",
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
    // The agent id is an argument: the payload does not name its CLI, and a
    // binding the deck cannot attribute is one it refuses.
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      "/bin/sh '/App/resources/kd-session-hook.sh' claude",
    );
    // No usage script resolved → no statusLine override rides along.
    expect(settings.statusLine).toBeUndefined();
    // No --session-id: claude mints its own id; the hook posts it back.
    expect(out.args).toHaveLength(2);
  });

  it("arms every turn-lifecycle event on one status reporter", async () => {
    const agent = activate(STATUS_HOOK);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    const settings = JSON.parse(out.args[1]);
    // The agent id is the ONLY argument. The script takes no others, and a
    // stale extra would be read as one — the reporter is silent on failure,
    // so a broken command stops status with no error anywhere.
    const command = "/bin/sh '/App/resources/kd-status-hook.sh' claude";
    // Each of these closes a hole the others cannot. StopFailure fires
    // INSTEAD of Stop on an API error; PostToolUseFailure fires INSTEAD of
    // PostToolUse when an approved tool then fails — both are the failure
    // half of a pair, and arming only the happy half strands the pane.
    // SubagentStart/SubagentStop bracket one agent turn, and an unpaired
    // bracket either holds a finished turn open or lets a busy teammate
    // read as done. SessionStart is the only report a manual `/compact`
    // produces — it runs through no turn — so without it a pane that
    // recorded a failure can never stop being red when the user rebuilds
    // its context. Losing any one is a silent hole in the lane.
    const armed = [
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "Notification",
      "PostToolUse",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
      "SessionStart",
    ];
    for (const event of armed) {
      expect(settings.hooks[event][0].hooks[0].command, event).toBe(command);
    }
    // EXACTLY these: an event armed by accident feeds the lane edges nobody
    // reasoned about, and the normalizer's default arm drops them silently.
    expect(Object.keys(settings.hooks).sort()).toEqual([...armed].sort());
  });

  it("lets both reporters ride SessionStart, in arming order", async () => {
    // The two lanes read the SAME event for different facts: identity takes
    // the session id, status takes a compaction. Assigning rather than
    // appending would silently drop whichever armed second — session
    // binding or the compaction signal — and neither failure announces
    // itself, so the shape is pinned here rather than left to review.
    const agent = activate({ ...SESSION_HOOK, ...STATUS_HOOK });
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    const settings = JSON.parse(out.args[1]);
    expect(
      settings.hooks.SessionStart.map(
        (entry: { hooks: { command: string }[] }) => entry.hooks[0].command,
      ),
    ).toEqual([
      "/bin/sh '/App/resources/kd-session-hook.sh' claude",
      "/bin/sh '/App/resources/kd-status-hook.sh' claude",
    ]);
    // The status reporter's other events are untouched by the sharing.
    expect(settings.hooks.Stop).toHaveLength(1);
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

  it("injected MCP servers ride --mcp-config on spawn AND resume", async () => {
    const agent = activate(SESSION_HOOK);
    const mcp = {
      servers: [
        {
          name: "keepdeck",
          transport: "stdio" as const,
          command: "/bin/keepdeck",
          args: ["--mcp-shim", "/home/mcp.sock"],
        },
      ],
    };

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, mcp }, spawn);
    expect(spawn.args).toContain("--mcp-config");

    // A resumed pane is the same session to the user, so it gets the same
    // servers — the resume hook must not be the one that forgets.
    const resume = output();
    await agent.hooks["resume.plan"]!({ ...input, mcp, sessionId: "s" }, resume);
    expect(resume.args).toContain("--mcp-config");

    const bare = output();
    await agent.hooks["spawn.plan"]!(input, bare);
    expect(bare.args).not.toContain("--mcp-config");
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
    expect(agent.supportsYolo).toBeUndefined();

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
  it("declares the Claude transcript usage tail", () => {
    expect(activate(null).usage?.tail).toBe("claude");
  });

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

  it("carries the injected MCP servers too — a fork is a spawn like any other", async () => {
    // The other fork assertions slice the argv's head and tail, so dropping
    // `mcpArgs(input.mcp)` from this hook would pass every one of them.
    const agent = activate(SESSION_HOOK, []);
    const out = output();
    await agent.hooks["fork.plan"]!(
      {
        ...forkInput,
        cwd: "/repo/wt_2.x",
        mcp: {
          servers: [
            {
              name: "keepdeck",
              transport: "stdio" as const,
              command: "/bin/keepdeck",
              args: ["--mcp-shim", "/home/mcp.sock"],
            },
          ],
        },
      },
      out,
    );

    const at = out.args.indexOf("--mcp-config");
    expect(at).toBeGreaterThan(-1);
    expect(JSON.parse(out.args[at + 1]!)).toEqual({
      mcpServers: {
        keepdeck: {
          command: "/bin/keepdeck",
          args: ["--mcp-shim", "/home/mcp.sock"],
        },
      },
    });
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

  it("slugs EVERY non-alphanumeric char like real claude, not just / . _", async () => {
    const copies: [string, string][] = [];
    const agent = activate(SESSION_HOOK, copies);
    await agent.hooks["fork.plan"]!(
      { ...forkInput, cwd: "/Users/John Doe/Projects/app (v2)" },
      output(),
    );
    // Spaces and parens become dashes too — the store encoding claude's own
    // sanitizePath applies (decompiled 2.1.215).
    expect(copies[0][1]).toBe(
      "/Users/u/.claude/projects/-Users-John-Doe-Projects-app--v2-/uuid-1.jsonl",
    );
  });

  it("refuses a >200-char slug loudly — claude truncates with a private hash we can't reproduce", async () => {
    const copies: [string, string][] = [];
    const agent = activate(SESSION_HOOK, copies);
    await expect(
      agent.hooks["fork.plan"]!(
        { ...forkInput, cwd: `/${"very-long-segment/".repeat(15)}end` },
        output(),
      ),
    ).rejects.toThrow("shorter path");
    expect(copies).toEqual([]); // zero writes on refusal
  });
});
