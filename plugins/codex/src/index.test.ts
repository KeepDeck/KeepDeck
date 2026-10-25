import { describe, expect, it } from "vitest";
import type { AgentContribution, SpawnPlanInput, SpawnPlanOutput } from "@keepdeck/plugin-api";
import { registerCodex } from "./index";
import { renderCodexMail, CODEX_MAIL_CHANNELS } from "./status";
import { codexUsageWatches } from "./usage";
import { present } from "@keepdeck/plugin-api/testing";

/** Register against typed fake ports; returns the registered agent. A
 * service a test does not fake rejects, the way a missing capability does.
 *
 * `scriptPath` stands for the resources DIRECTORY and every name resolves
 * inside it. It used to answer ONE path for every name, which made the two
 * reporters indistinguishable: swapping which script armed the turn events,
 * or misspelling a resource name, left every test green while production
 * lost all status and all mail. Null means nothing resolves, as on a broken
 * install. */
function activate(scriptPath: string | null): AgentContribution {
  let agent: AgentContribution | undefined;
  const absent = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available here`);
  };
  registerCodex({
    agents: { register: (a: AgentContribution) => ((agent = a), { dispose() {} }) },
    resources: {
      path: async (name: string) =>
        scriptPath === null ? null : scriptPath.replace(/[^/]+$/, name),
    },
    log: { info() {}, warn() {}, error() {} },
    services: {
      fs: { readDir: absent("fs") },
      sessionStore: { read: absent("sessionStore") },
    },
  });
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
  it("injected MCP servers ride -c overrides on spawn AND resume", async () => {
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
    await present(activate("/kd/hook.sh").hooks["spawn.plan"], "the spawn.plan hook")({ ...input, mcp }, spawn);
    // Bare, not quoted: codex reads the key literally and refuses a quoted
    // one outright — see mcp.test.ts.
    expect(spawn.args.join(" ")).toContain("mcp_servers.keepdeck=");

    const resume = output();
    await present(activate("/kd/hook.sh").hooks["resume.plan"], "the resume.plan hook")({ ...input, mcp, sessionId: "s" }, resume);
    // Global overrides must stay AHEAD of the `resume` subcommand.
    const overrideAt = resume.args.findIndex((a) => a.startsWith("mcp_servers."));
    expect(overrideAt).toBeGreaterThan(-1);
    expect(overrideAt).toBeLessThan(resume.args.indexOf("resume"));

    // A fork is a spawn like any other, and its own assertions slice the
    // argv's head and tail — so dropping mcpArgs there would pass them all.
    const fork = output();
    await present(activate("/kd/hook.sh").hooks["fork.plan"], "the fork.plan hook")(
      { ...input, mcp, sessionId: "uuid-9", sourceCwd: "/old" },
      fork,
    );
    const forkOverrideAt = fork.args.findIndex((a) => a.startsWith("mcp_servers."));
    expect(forkOverrideAt).toBeGreaterThan(-1);
    expect(forkOverrideAt).toBeLessThan(fork.args.indexOf("fork"));

    const bare = output();
    await present(activate("/kd/hook.sh").hooks["spawn.plan"], "the spawn.plan hook")(input, bare);
    expect(bare.args.join(" ")).not.toContain("mcp_servers.");
  });

  it("arms the identity and status hooks via -c overrides, id NOT adopted", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);

    // 7 rules (SessionStart + 6 status events) ×2 args, ONE combined state
    // table ×2, + 2 paste-burst override args.
    expect(out.args).toHaveLength(18);
    expect(out.args[0]).toBe("-c");
    // The IDENTITY hook on SessionStart, by name. The two reporters answer
    // different questions and only one of them may sit here; a stub that
    // could not tell them apart let the wrong one be armed unnoticed.
    expect(out.args[1]).toContain(
      `command="/bin/sh '/App/resources/kd-session-hook.sh' codex"`,
    );
    // And the STATUS hook on every turn event, never the identity one.
    for (const arg of out.args.filter((a) => /^hooks\.(UserPromptSubmit|Stop)=/.test(a))) {
      expect(arg).toContain("kd-status-hook.sh");
      expect(arg).not.toContain("kd-session-hook.sh");
    }
    for (const event of [
      "UserPromptSubmit",
      "Stop",
      "PermissionRequest",
      "PostToolUse",
      "Interrupt",
      "PostCompact",
    ]) {
      expect(
        out.args.filter((a) => a.startsWith(`hooks.${event}=`)),
      ).toHaveLength(1);
    }
    // WHICH events ask the deck back, pinned because nothing else would
    // notice it changing: the reporter is silent on failure, so a stale or
    // missing `--ask` stops mail reaching this CLI with no error anywhere.
    // Stop blocks and continues; UserPromptSubmit spills into the turn just
    // opened; PostToolUse does the same while the turn is still RUNNING,
    // which is the only way to reach a working agent without typing into its
    // terminal — and it is the one that costs a round trip per tool call.
    // PermissionRequest reads nothing back.
    for (const [event, asks] of [
      ["Stop", true],
      ["UserPromptSubmit", true],
      ["PostToolUse", true],
      ["PermissionRequest", false],
      ["Interrupt", false],
      ["PostCompact", false],
    ] as const) {
      const rule = present(out.args.find((a) => a.startsWith(`hooks.${event}=`)), "the matching item");
      expect(rule.includes("codex --ask"), event).toBe(asks);
    }
    // Trust must be ONE table: codex takes the last `-c hooks.state=`
    // wholesale, so a second table would silently untrust the first.
    const state = out.args.filter((a) => a.startsWith("hooks.state="));
    expect(state).toHaveLength(1);
    expect(state[0].match(/trusted_hash/g)).toHaveLength(8);
    // SessionStart carries BOTH reporters as two handlers of its one group:
    // a second `hooks.SessionStart` would replace the first and drop session
    // binding. Identity stays handler 0, the mail ask is handler 1, each with
    // its own trust key.
    const sessionStart = out.args.filter((a) => a.startsWith("hooks.SessionStart="));
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart[0]).toMatch(
      /^hooks\.SessionStart=\[\{hooks=\[\{[^}]*kd-session-hook\.sh' codex"\},\{[^}]*kd-status-hook\.sh' codex --ask"[^}]*\}\]\}\]$/,
    );
    expect(state[0]).toContain("session_start:0:0");
    expect(state[0]).toContain("session_start:0:1");
    // Long mail is kept whole where codex can carry context, and declared
    // nowhere else — codex drops the field there before hashing.
    for (const [event, limited] of [
      ["UserPromptSubmit", true],
      ["PostToolUse", true],
      ["SessionStart", true],
      ["Stop", false],
      ["Interrupt", false],
    ] as const) {
      const rule = present(out.args.find((a) => a.startsWith(`hooks.${event}=`)), "the matching item");
      expect(rule.includes("additionalContextLimit=0"), event).toBe(limited);
    }
    expect(out.args).toContain("disable_paste_burst=true");
  });

  it("disables paste-burst on every spawn path, before the subcommand", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");

    const spawn = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, spawn);
    expect(spawn.args).toContain("disable_paste_burst=true");

    const resume = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")({ ...input, sessionId: "uuid-9" }, resume);
    expect(resume.args).toContain("disable_paste_burst=true");
    // The override precedes the `resume` subcommand (it is a global `-c`).
    expect(resume.args.indexOf("disable_paste_burst=true")).toBeLessThan(
      resume.args.indexOf("resume"),
    );

    const fork = output();
    await present(agent.hooks["fork.plan"], "the fork.plan hook")(
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
    await present(agent.hooks["resume.plan"], "the resume.plan hook")({ ...input, sessionId: "uuid-9" }, out);

    expect(out.args.slice(0, 1)).toEqual(["-c"]);
    expect(out.args.slice(-2)).toEqual(["resume", "uuid-9"]);
  });

  it("fork.plan is args-only: global flags, then the fork subcommand", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const out = output();
    await present(agent.hooks["fork.plan"], "the fork.plan hook")(
      { ...input, sessionId: "uuid-9", sourceCwd: "/somewhere/else" },
      out,
    );

    // No surgery, no sourceCwd use — codex resolves the id globally.
    expect(out.args.slice(0, 1)).toEqual(["-c"]);
    expect(out.args.slice(-2)).toEqual(["fork", "uuid-9"]);

    const yolo = output();
    await present(agent.hooks["fork.plan"], "the fork.plan hook")(
      { ...input, yolo: true, sessionId: "u", sourceCwd: "/x" },
      yolo,
    );
    expect(yolo.args.slice(0, 1)).toEqual(["-c"]);
    expect(yolo.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("drops the hook when the script is missing; the paste-burst override still applies", async () => {
    const agent = activate(null);
    const out = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, out);
    expect(out.args).toEqual(["-c", "disable_paste_burst=true"]);
    expect(out.args.join(" ")).not.toContain("trusted_hash");

    const resume = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")({ ...input, sessionId: "x" }, resume);
    expect(resume.args).toEqual([
      "-c",
      "disable_paste_burst=true",
      "resume",
      "x",
    ]);
  });

  it("YOLO adds the global bypass flag, BEFORE the resume subcommand", async () => {
    const agent = activate(null);

    const spawn = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")({ ...input, yolo: true }, spawn);
    expect(spawn.args).toEqual([
      "-c",
      "disable_paste_burst=true",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);

    const resume = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")(
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

  it("prepends `--remote <ep>` (before globals and subcommand) on a nativeServer target", async () => {
    const agent = activate("/App/resources/kd-session-hook.sh");
    const target = { kind: "nativeServer" as const, endpoint: "ws://vps:4500" };

    const spawn = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")({ ...input, target }, spawn);
    expect(spawn.args.slice(0, 2)).toEqual(["--remote", "ws://vps:4500"]);
    // globals (-c) still land after --remote, before any subcommand
    expect(spawn.args[2]).toBe("-c");

    const resume = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")(
      { ...input, target, sessionId: "uuid-9" },
      resume,
    );
    expect(resume.args.slice(0, 2)).toEqual(["--remote", "ws://vps:4500"]);
    expect(resume.args.slice(-2)).toEqual(["resume", "uuid-9"]);

    const fork = output();
    await present(agent.hooks["fork.plan"], "the fork.plan hook")(
      { ...input, target, sessionId: "uuid-9", sourceCwd: "/x" },
      fork,
    );
    expect(fork.args.slice(0, 2)).toEqual(["--remote", "ws://vps:4500"]);
    expect(fork.args.slice(-2)).toEqual(["fork", "uuid-9"]);
  });

  it("emits no --remote without a target (local pane unchanged)", async () => {
    const agent = activate(null);
    const spawn = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(input, spawn);
    expect(spawn.args.some((a) => a === "--remote")).toBe(false);
  });

  it("combines --remote and YOLO on a fresh spawn (order: remote, then bypass)", async () => {
    // Security-adjacent: a reorder must not silently drop --remote (which
    // would run locally) nor the bypass flag (approvals on the remote server).
    const agent = activate(null);
    const target = { kind: "nativeServer" as const, endpoint: "ws://vps:4500" };
    const spawn = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")({ ...input, target, yolo: true }, spawn);
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
    await present(agent.hooks["resume.plan"], "the resume.plan hook")(
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

describe("codex panes run their own process", () => {
  const agent = activate("/App/resources/kd-session-hook.sh");
  const remote = { kind: "nativeServer" as const, endpoint: "ws://vps:4500" };
  /** Every way a pane launches, with the subcommand each must keep last. */
  const launches = async (
    over: Partial<SpawnPlanInput>,
  ): Promise<Array<{ name: string; args: string[]; tail: string[] }>> => {
    const given = { ...input, ...over };
    const spawn = output();
    await present(agent.hooks["spawn.plan"], "the spawn.plan hook")(given, spawn);
    const resume = output();
    await present(agent.hooks["resume.plan"], "the resume.plan hook")(
      { ...given, sessionId: "uuid-9" },
      resume,
    );
    const fork = output();
    await present(agent.hooks["fork.plan"], "the fork.plan hook")(
      { ...given, sessionId: "uuid-9", sourceCwd: "/x" },
      fork,
    );
    return [
      { name: "spawn", args: spawn.args, tail: [] },
      { name: "resume", args: resume.args, tail: ["resume", "uuid-9"] },
      { name: "fork", args: fork.args, tail: ["fork", "uuid-9"] },
    ];
  };

  it.each(["0.156.0", "0.164.0", "0.156", "1.0.0"])(
    "%s states --no-daemon on spawn, resume and fork, ahead of the subcommand",
    async (cliVersion) => {
      for (const launch of await launches({ cliVersion })) {
        // Exactly once, and first: a global flag that codex keeps whether it
        // comes before or after the subcommand, put where every global goes.
        expect(launch.args.filter((a) => a === "--no-daemon"), launch.name).toHaveLength(1);
        expect(launch.args[0], launch.name).toBe("--no-daemon");
        expect(launch.args.slice(launch.args.length - launch.tail.length), launch.name).toEqual(
          launch.tail,
        );
        // The `-c` stay as they were: the flag adds to them, it replaces none.
        expect(launch.args, launch.name).toContain("disable_paste_burst=true");
      }
    },
  );

  it.each([
    ["older than the flag", "0.155.9"],
    ["far older", "0.99.0"],
    ["illegible", "codex-cli"],
    ["unknown", undefined],
  ])("an %s release (%s) gets no --no-daemon: a flag codex lacks aborts the pane", async (_why, cliVersion) => {
    for (const launch of await launches(cliVersion === undefined ? {} : { cliVersion })) {
      expect(launch.args, launch.name).not.toContain("--no-daemon");
      // What kept such a pane off the daemon before still does.
      expect(launch.args, launch.name).toContain("disable_paste_burst=true");
    }
  });

  it("never pairs --no-daemon with --remote, which codex refuses", async () => {
    for (const launch of await launches({ cliVersion: "0.164.0", target: remote })) {
      expect(launch.args, launch.name).not.toContain("--no-daemon");
      expect(launch.args.slice(0, 2), launch.name).toEqual(["--remote", "ws://vps:4500"]);
    }
  });

  it("declares the same rule as its bare floor, and nothing else", async () => {
    const floor = present(agent.hooks["bare.plan"], "the bare.plan hook");
    const floorOf = async (over: Partial<SpawnPlanInput>) => {
      const out = output();
      await floor({ ...input, ...over }, out);
      return out;
    };

    const current = await floorOf({ cliVersion: "0.164.0" });
    expect(current.args).toEqual(["--no-daemon"]);
    expect(current.env).toEqual([]);
    expect(current.command).toBe("codex");
    expect((await floorOf({ cliVersion: "0.155.0" })).args).toEqual([]);
    expect((await floorOf({})).args).toEqual([]);
    // The host never degrades a remote pane to bare, but the floor is the
    // same rule all the same, so it cannot drift into the forbidden pair.
    expect((await floorOf({ cliVersion: "0.164.0", target: remote })).args).not.toContain(
      "--no-daemon",
    );
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
    expect(agent.usage?.tail?.watches).toEqual(codexUsageWatches);
    // A rollout records the ACCOUNT's limits, so codex asks to be swept at
    // boot — it is also run outside the deck, where quota is spent unseen.
    expect(agent.usage?.tail?.sweep).toBeTypeOf("function");
    expect(agent.usage?.limits?.poll).toBe("codex-app-server");
  });

  it("contributes its mail renderer, which is what puts it on the labelled channel", () => {
    // By identity: the deck looks for exactly this field to decide whether a
    // pane is worth holding mail for, so a plugin that renders mail perfectly
    // and forgets to contribute it has its messages typed into a terminal
    // instead — with every renderer test still green.
    const agent = activate("/App/resources/kd-session-hook.sh");
    expect(agent.status?.mail?.render).toBe(renderCodexMail);
    expect(agent.status?.mail?.channels).toBe(CODEX_MAIL_CHANNELS);
  });
});
