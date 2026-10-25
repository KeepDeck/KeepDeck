import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  AgentContribution,
  SettingsSectionContribution,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import { mergeSectionValues } from "@keepdeck/plugin-api";
import { registerClaude } from "./index";
import { ARTIFACTS_FIELD, DISABLE_ARTIFACTS_VAR } from "./artifacts";
import { CLAUDE_MAIL_CHANNELS, renderClaudeMail } from "./status";

/** The events armed to ask, from the declaration both the arming and the
 * deck read. */
const ASKS_FOR_MAIL = new Set(CLAUDE_MAIL_CHANNELS.map((channel) => channel.event));
import { claudeUsageWatches } from "./usage";
import { present } from "@keepdeck/plugin-api/testing";
import { numberOf, recordsOf } from "@keepdeck/plugin-api/testing";

/** The section this plugin registered during the last [`activate`]. */
let registered: SettingsSectionContribution | undefined;

/** Register against typed fake ports; returns the registered agent. A
 * service a test does not fake rejects, the way a missing capability does.
 * `resources` maps script name → resolved path (missing name = null), so a
 * test can arm the two reporters independently. `stored` is what the
 * settings file holds for this plugin — resolved through the CONTRACT's own
 * merge, the way the host resolves it, so a field declared under one key and
 * read under another fails here instead of shipping. */
function activate(
  resources: Record<string, string> | null,
  copies: [string, string][] = [],
  stored: Record<string, unknown> = {},
): AgentContribution {
  let agent: AgentContribution | undefined;
  registered = undefined;
  const absent = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available here`);
  };
  registerClaude({
    agents: { register: (a: AgentContribution) => ((agent = a), { dispose() {} }) },
    log: { info() {}, warn() {}, error() {} },
    resources: { path: async (name: string) => resources?.[name] ?? null },
    settings: {
      registerSection: (section: SettingsSectionContribution) => (
        (registered = section), { dispose() {} }
      ),
      read: async () => mergeSectionValues(registered, stored),
    },
    services: {
      // A store holding the forked session's transcript and nothing else.
      fs: {
        readDir: async (path) =>
          path === "/Users/u/.claude/projects/-old-worktree"
            ? [{ name: "uuid-1.jsonl", path: `${path}/uuid-1.jsonl`, kind: "file" }]
            : path === "/Users/u/.claude"
              ? [{ name: "projects", path: `${path}/projects`, kind: "dir" }]
              : [],
      },
      fsWrite: {
        copyFile: async (src, dst) => {
          copies.push([src, dst]);
        },
        remove: async () => {},
      },
      sessionStore: { read: absent("sessionStore") },
      sessions: { spawn: absent("sessions") },
    },
  });
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

/** What one armed hook runs: the program, then its arguments — the exec
 * form, with no shell between them. */
const argv = (entry: { hooks: { command: string; args?: string[] }[] }) => [
  entry.hooks[0].command,
  ...(entry.hooks[0].args ?? []),
];

describe("claude plugin hooks", () => {
  it("arms the SessionStart reporter — identity is reporter-based", async () => {
    const agent = activate(SESSION_HOOK);
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);

    expect(out.args[0]).toBe("--settings");
    const settings = JSON.parse(out.args[1]);
    // The agent id is an argument: the payload does not name its CLI, and a
    // binding the deck cannot attribute is one it refuses.
    expect(argv(settings.hooks.SessionStart[0])).toEqual([
      "/bin/sh",
      "/App/resources/kd-session-hook.sh",
      "claude",
    ]);
    // No usage script resolved → no statusLine override rides along.
    expect(settings.statusLine).toBeUndefined();
    // No --session-id: claude mints its own id; the hook posts it back.
    expect(out.args).toHaveLength(2);
  });

  it("arms every turn-lifecycle event on one status reporter", async () => {
    const agent = activate(STATUS_HOOK);
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);

    const settings = JSON.parse(out.args[1]);
    // The agent id is the ONLY argument. The script takes no others, and a
    // stale extra would be read as one — the reporter is silent on failure,
    // so a broken command stops status with no error anywhere.
    const command = ["/bin/sh", "/App/resources/kd-status-hook.sh", "claude"];
    // Some of them ask as well as report. `--ask` makes the reporter wait
    // for the deck's answer and print it — Stop hands mail over without a
    // fresh wake, UserPromptSubmit appends to the turn just opened, and
    // PostToolBatch injects context into the next model request, while the
    // turn is still running. Arming it on the rest would
    // buy a round trip per TOOL CALL for an answer that event cannot use.
    const asking = [...command, "--ask"];
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
      expect(argv(settings.hooks[event][0]), event).toEqual(
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
      for (const entry of recordsOf(settings.hooks[event], "hook entries")) {
        const hooks = recordsOf(entry.hooks, "hook commands");
        expect(numberOf(hooks[0]?.timeout, "hook timeout"), event).toBeGreaterThanOrEqual(5);
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
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);

    const settings = JSON.parse(out.args[1]);
    expect(
      settings.hooks.SessionStart.map(argv),
    ).toEqual([
      // Identity first, and it never asks: it answers a different question
      // and takes no reply, so arming it to ask would make it wait out its
      // whole window for a file nobody writes.
      ["/bin/sh", "/App/resources/kd-session-hook.sh", "claude"],
      // Status asks here, and this is the only event where a STARTING pane
      // can be told anything at all.
      ["/bin/sh", "/App/resources/kd-status-hook.sh", "claude", "--ask"],
    ]);
    // The status reporter's other events are untouched by the sharing.
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("arms the statusLine usage reporter alongside identity", async () => {
    const agent = activate({ ...SESSION_HOOK, ...USAGE_HOOK });
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);

    const settings = JSON.parse(out.args[1]);
    expect(settings.statusLine).toEqual({
      type: "command",
      command: "/bin/sh '/App/resources/kd-usage-statusline.sh'",
      refreshInterval: 60,
    });
    expect(argv(settings.hooks.SessionStart[0])).toContain(
      "/App/resources/kd-session-hook.sh",
    );
  });

  it("hands a path to the hook as one argument, whatever it holds", async () => {
    // The exec form's whole point: no shell parses the path, so a space or
    // either quote is just part of it — nothing to escape, nothing to break.
    const awkward = "/Users/Jo O'Neil/\"Apps\"/kd-status-hook.sh";
    const agent = activate({ "kd-status-hook.sh": awkward });
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);
    const settings = JSON.parse(out.args[1]);
    expect(argv(settings.hooks.Stop[0])).toEqual(["/bin/sh", awkward, "claude", "--ask"]);
  });

  it("each reporter degrades independently when its script is missing", async () => {
    const agent = activate(USAGE_HOOK);
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);

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
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")({ ...input, mcp }, spawn);
    expect(spawn.args).toContain("--mcp-config");

    // A resumed pane is the same session to the user, so it gets the same
    // servers — the resume hook must not be the one that forgets.
    const resume = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")({ ...input, mcp, sessionId: "s" }, resume);
    expect(resume.args).toContain("--mcp-config");

    const bare = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, bare);
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
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")({ ...input, skills }, spawn);
    expect(spawn.args.slice(2)).toEqual([
      "--plugin-dir",
      "/kd/staging/ws-1/claude-plugin",
    ]);

    const resume = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")({ ...input, skills, sessionId: "s" }, resume);
    expect(resume.args.slice(2)).toEqual([
      "--plugin-dir",
      "/kd/staging/ws-1/claude-plugin",
      "--resume",
      "s",
    ]);

    // No skills staged — the flag must not appear at all.
    const bare = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, bare);
    expect(bare.args).not.toContain("--plugin-dir");
    expect(JSON.parse(present(bare.args[bare.args.indexOf("--settings") + 1], "the bare.args at the index")).enabledPlugins).toBeUndefined();
  });

  it("resume reuses the recorded id and keeps the reporter armed", async () => {
    const agent = activate(SESSION_HOOK);
    const out = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")({ ...input, sessionId: "old-id" }, out);

    expect(out.args[0]).toBe("--settings");
    expect(out.args.slice(2)).toEqual(["--resume", "old-id"]);
  });

  it("degrades to a bare spawn when both reporter scripts are missing", async () => {
    const agent = activate(null);
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);

    expect(out.args).toEqual([]);
  });

  it("YOLO adds the skip-permissions flag on spawn and resume alike", async () => {
    const agent = activate(null);

    const spawn = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")({ ...input, yolo: true }, spawn);
    expect(spawn.args).toEqual(["--dangerously-skip-permissions"]);

    const resume = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")(
      { ...input, yolo: true, sessionId: "old-id" },
      resume,
    );
    expect(resume.args).toEqual([
      "--dangerously-skip-permissions",
      "--resume",
      "old-id",
    ]);
  });

  it("offers claude's own artifacts as the plugin's one switch", () => {
    activate(null);
    // The field the page renders IS the field the hook reads — the fake
    // resolves through `mergeSectionValues`, so a drift between the two would
    // leave every plan below carrying no variable.
    expect(registered).toEqual({
      label: "Claude Code",
      fields: [ARTIFACTS_FIELD],
    });
  });

  it("switched off, disables claude's artifacts on spawn AND resume", async () => {
    const agent = activate(null, [], { artifacts: false });

    const spawn = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, spawn);
    expect(spawn.env).toEqual([[DISABLE_ARTIFACTS_VAR, "1"]]);

    // A resumed pane is the same session to the user: the switch it was
    // spawned under must not lapse the first time it is woken.
    const resume = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")({ ...input, sessionId: "s" }, resume);
    expect(resume.env).toEqual([[DISABLE_ARTIFACTS_VAR, "1"]]);
  });

  it("leaves the pane environment alone while they are on — the deck has no opinion", async () => {
    const agent = activate(null);
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);
    expect(out.env).toEqual([]);
  });
});

describe("claude plugin identity", () => {
  it("declares the Claude transcript usage tail", () => {
    const tail = activate(null).usage?.tail;
    // Which records carry the numbers, and where the same session's other
    // files are. The host reads neither — it applies them.
    expect(tail?.watches).toEqual(claudeUsageWatches);
    expect(tail?.siblings?.("/p/session-1.jsonl")).toBe(
      "/p/session-1/subagents",
    );
  });

  it("ships the brand mark in Anthropic's tint", () => {
    const agent = activate(null);
    expect(agent.icon?.viewBox).toBe("0 0 24 24");
    expect(agent.icon?.paths).toHaveLength(1);
    expect(agent.icon?.paths[0].d).toBeTruthy();
    expect(agent.icon?.paths[0].color).toBe("#D97757");
  });
});

describe("claude's Mod", () => {
  it("loads it per spawn as a second local plugin, when the bundle has it", async () => {
    const agent = activate({
      ...SESSION_HOOK,
      "keepdeck-mod/.claude-plugin/plugin.json": "/App/resources/keepdeck-mod/.claude-plugin/plugin.json",
    });
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);
    const at = out.args.indexOf("--plugin-dir");
    expect(out.args[at + 1]).toBe("/App/resources/keepdeck-mod");
    // Kept on even where the user switched it off — under the inline key
    // claude gives it, and the name its manifest declares.
    const settings = JSON.parse(present(out.args[out.args.indexOf("--settings") + 1], "the out.args at the index"));
    expect(settings.enabledPlugins).toEqual({ "keepdeck-reporter@inline": true });
    const manifest = JSON.parse(
      readFileSync("plugins/claude/resources/keepdeck-mod/.claude-plugin/plugin.json", "utf8"),
    );
    expect(manifest.name).toBe("keepdeck-reporter");
    // Missing from the bundle: the pane runs without it, nothing else moves.
    const bare = output();
    await present(activate(SESSION_HOOK).hooks["spawn.plan"], "the spawn.plan hook")(input, bare);
    expect(bare.args).not.toContain("--plugin-dir");
    expect(JSON.parse(present(bare.args[bare.args.indexOf("--settings") + 1], "the bare.args at the index")).enabledPlugins).toBeUndefined();
  });

  it("declares that its hello takes over the tail's status records and the wake", () => {
    const agent = activate(null);
    expect(agent.companion).toEqual({ covers: ["status-records"] });
    // Rung through the Mod while the pane's process has it, typed otherwise.
    expect(agent.status?.wake).toBe("companion");
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

  it("forks through claude's own --fork-session, under an id chosen before it starts", async () => {
    // The surgery itself is fork.ts's (fork.test.ts); this pins that the
    // hook launches through it and hands the host its scaffolding.
    const copies: [string, string][] = [];
    const agent = activate(SESSION_HOOK, copies);
    const out = output();
    await present(agent.hooks["fork.plan"], "the fork.plan hook")({ ...forkInput, cwd: "/repo/wt_2.x" }, out);

    const [, forkId, , , scratchId] = out.args.slice(-5);
    expect(out.args.slice(-5)).toEqual(["--session-id", forkId, "--fork-session", "--resume", scratchId]);
    expect(forkId).not.toBe(scratchId);
    const target = "/Users/u/.claude/projects/-repo-wt-2-x";
    expect(copies).toEqual([
      ["/Users/u/.claude/projects/-old-worktree/uuid-1.jsonl", `${target}/${scratchId}.jsonl`],
    ]);
    expect(out.discard).toEqual({
      onceStarted: [`${target}/${scratchId}.jsonl`],
      ifNeverStarted: [
        `${target}/${scratchId}.jsonl`,
        `${target}/${forkId}`,
        `/Users/u/.claude/tasks/${forkId}`,
      ],
    });
  });

  it("carries the injected MCP servers too — a fork is a spawn like any other", async () => {
    // The other fork assertions slice the argv's head and tail, so dropping
    // `mcpArgs(input.mcp)` from this hook would pass every one of them.
    const agent = activate(SESSION_HOOK, []);
    const out = output();
    await present(agent.hooks["fork.plan"], "the fork.plan hook")(
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
    expect(JSON.parse(present(out.args[at + 1], "the out.args at the index"))).toEqual({
      mcpServers: {
        keepdeck: {
          command: "/bin/keepdeck",
          args: ["--mcp-shim", "/home/mcp.sock"],
        },
      },
    });
  });

  it("carries the artifacts switch too — every other fork assertion reads argv", async () => {
    // Same hole as the MCP one above, on the OTHER output: dropping the env
    // line from this hook alone would pass every argv assertion here, and a
    // forked pane would quietly regain what its source was denied.
    const agent = activate(SESSION_HOOK, [], { artifacts: false });
    const out = output();
    await present(agent.hooks["fork.plan"], "the fork.plan hook")({ ...forkInput, cwd: "/repo/wt_2.x" }, out);
    expect(out.env).toEqual([[DISABLE_ARTIFACTS_VAR, "1"]]);
  });

  it("spawn.plan never emits the CLI's agents screen — the connect path is gone", async () => {
    // DEMOLITION, the absence half: no spawn input may open the CLI's own
    // agent screen anymore. The ordinary shape is pinned by the suite
    // around; this pins that its argv vocabulary has no such entry.
    const agent = activate(SESSION_HOOK);
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")({ ...input, yolo: true }, out);
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
    expect(agent.status?.mail?.render).toBe(renderClaudeMail);
    expect(agent.status?.mail?.channels).toBe(CLAUDE_MAIL_CHANNELS);
  });
});
