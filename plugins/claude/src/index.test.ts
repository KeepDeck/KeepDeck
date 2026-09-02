import { describe, expect, it } from "vitest";
import type {
  AgentContribution,
  PluginContext,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import plugin from "./index";
import { ASKS_FOR_MAIL, renderClaudeMail } from "./status";
import { claudeUsageWatches } from "./usage";

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
    // Some of them ask as well as report. `--ask` makes the reporter wait
    // for the deck's answer and print it — Stop can be blocked to hand mail
    // over without a fresh wake, UserPromptSubmit can append to the turn
    // just opened, and PostToolBatch takes the same block one boundary
    // earlier, while the turn is still running. Arming it on the rest would
    // buy a round trip per TOOL CALL for an answer that event cannot use.
    const asking = `${command} --ask`;
    // SessionStart asks too, on the STATUS reporter: a freshly spawned
    // agent has no turn and reports nothing, so this is the only moment its
    // briefing can reach it without a keystroke typed into a booting CLI.
    // From the renderer's own declaration, not a copy of it: the arming and
    // the rendering must agree, and nothing else would notice them
    // disagreeing — armed-but-unrendered burns the hook's whole wait on
    // every fire, rendered-but-unarmed sends that event's mail through a
    // paid terminal nudge, and both are silent.
    const asks = ASKS_FOR_MAIL;
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
    //
    // PostToolBatch is the exception to that sentence: it closes no hole in
    // the lane and reports no edge the other nine lack. It is armed for MAIL
    // alone — the one moment a running turn can be reached without a
    // keystroke — which is why it appears here and never in the normalizer.
    const armed = [
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "Notification",
      "PostToolUse",
      "PostToolUseFailure",
      "PostToolBatch",
      "SubagentStart",
      "SubagentStop",
      "SessionStart",
    ];
    for (const event of armed) {
      expect(settings.hooks[event][0].hooks[0].command, event).toBe(
        asks.has(event) ? asking : command,
      );
    }
    // EXACTLY these: an event armed by accident feeds the lane edges nobody
    // reasoned about, and the normalizer's default arm drops them silently.
    expect(Object.keys(settings.hooks).sort()).toEqual([...armed].sort());
    // And EVERY one carries a limit of ours. claude's own default is not
    // something this deck can read, and a limit under the reporter's ~2s
    // wait would kill it mid-round-trip — losing not a status edge but
    // MAIL, which the deck hands over before the answer is written. It
    // would then sit in the pane's inbox, never in its context, silently on
    // both sides.
    for (const event of armed) {
      for (const entry of settings.hooks[event] as {
        hooks: { timeout?: number }[];
      }[]) {
        expect(entry.hooks[0].timeout, event).toBeGreaterThanOrEqual(5);
      }
    }
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
      // Identity first, and it never asks: it answers a different question
      // and takes no reply, so arming it to ask would make it wait out its
      // whole window for a file nobody writes.
      "/bin/sh '/App/resources/kd-session-hook.sh' claude",
      // Status asks here, and this is the only event where a STARTING pane
      // can be told anything at all.
      "/bin/sh '/App/resources/kd-status-hook.sh' claude --ask",
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
    const tail = activate(null).usage?.tail;
    expect(tail?.format).toBe("claude");
    // And says which records carry the numbers — the host reads none of it.
    expect(tail?.watches).toEqual(claudeUsageWatches);
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

  it("derives the transcript path from the recorded cwd when none was delivered", async () => {
    // The occupied-resume card's fork carries no transcript path — the
    // plugin owns the store layout and derives it. For the card's
    // same-directory fork the derived path merely proves target ===
    // source: nothing is read, nothing is copied.
    const copies: [string, string][] = [];
    const agent = activate(null, copies);
    const out = output();
    await agent.hooks["fork.plan"]!(
      { ...input, sessionId: "uuid-1", sourceCwd: "/old/worktree", cwd: "/old/worktree" },
      out,
    );
    expect(copies).toEqual([]);
    expect(out.args.slice(-3)).toEqual(["--resume", "uuid-1", "--fork-session"]);
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

  it("branching in place skips the copy SILENTLY — the file already sits where it would land", async () => {
    // The fork card never chooses a directory, so source dir = target dir
    // is the card's NORMAL shape, not an error. The copy would be a
    // same-file copy (which the host refuses loudly for everyone else) —
    // only the plugin knows this one is legitimate, so only it may skip.
    const copies: [string, string][] = [];
    const agent = activate(SESSION_HOOK, copies);
    const out = output();
    await agent.hooks["fork.plan"]!(
      {
        ...forkInput,
        // Same slug as the transcript's own dir → target === source.
        cwd: "/old/worktree",
      },
      out,
    );
    expect(copies).toEqual([]);
    expect(out.args.slice(-3)).toEqual(["--resume", "uuid-1", "--fork-session"]);
  });

  it("spawn.plan never emits the CLI's agents screen — the connect path is gone", async () => {
    // DEMOLITION, the absence half: no spawn input may open the CLI's own
    // agent screen anymore. The ordinary shape is pinned by the suite
    // around; this pins that its argv vocabulary has no such entry.
    const agent = activate(SESSION_HOOK);
    const out = output();
    await agent.hooks["spawn.plan"]!({ ...input, yolo: true }, out);
    expect(out.args).not.toContain("agents");
    expect(out.args).toContain("--dangerously-skip-permissions");
  });

  it("contributes its mail renderer, which is what puts it on the labelled channel", () => {
    // Asserted by IDENTITY, not by "something is defined": the deck decides
    // whether a pane is worth holding mail for by looking for exactly this
    // field, so a plugin that renders mail perfectly and forgets to
    // contribute it falls back to having its messages typed into a terminal
    // — with every renderer test still green.
    const agent = activate({ ...SESSION_HOOK, ...STATUS_HOOK });
    expect(agent.status?.renderMail).toBe(renderClaudeMail);
  });
});
