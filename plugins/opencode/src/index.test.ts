import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentContribution, SpawnPlanOutput } from "@keepdeck/plugin-api";
import {
  fakeOpencode,
  v1Session,
  v2Session,
  type FakeOpencodeOptions,
} from "./fakeOpencode.test-support";
import { registerOpencode, type OpencodePorts } from "./index";
import { OPENCODE_SESSION_ENV } from "./opening";

/** This plugin's real resources, which the fake below answers from. */
const RESOURCES = join(__dirname, "..", "resources");

/** Register against typed fake ports; returns the registered agent. A
 * service a test does not fake rejects, the way a missing capability does.
 *
 * `resourcesRoot` is where the bundle's resources appear to live. The fake
 * answers the way the host does (src-tauri plugins_fs.rs
 * plugin_resource_path): a path only for a FILE that really ships, null for a
 * directory or anything missing — a fake answering every name hid a plugin
 * that asked for a directory. Null means nothing resolves, as on a broken
 * install. */
type Services = OpencodePorts["services"];
function activate(
  resourcesRoot: string | null,
  services: { [K in keyof Services]?: Partial<Services[K]> } = {},
): AgentContribution {
  let agent: AgentContribution | undefined;
  const absent = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available here`);
  };
  registerOpencode({
    agents: { register: (a: AgentContribution) => ((agent = a), { dispose() {} }) },
    resources: {
      path: async (name: string) => {
        if (resourcesRoot === null) return null;
        const shipped = statSync(join(RESOURCES, name), { throwIfNoEntry: false });
        return shipped?.isFile() ? `${resourcesRoot}/${name}` : null;
      },
    },
    log: { info() {}, warn() {}, error() {} },
    services: {
      sessions: { spawn: absent("sessions"), ...services.sessions },
      fs: { readFile: absent("fs"), readDir: absent("fs"), ...services.fs },
      fsWrite: { writeFile: absent("fsWrite"), remove: absent("fsWrite"), ...services.fsWrite },
      sqlite: { query: absent("sqlite"), ...services.sqlite },
      exec: { runOnce: absent("exec"), ...services.exec },
    },
  });
  if (!agent) throw new Error("plugin registered no agent");
  return agent;
}

/** A source session with a real opencode id shape: the fork remints it. */
const SRC = "ses_0db9e24cbffej1WlbsRKynAHf3";

/** The host's services over a fake opencode holding SRC — of 1.x unless
 * told otherwise (fakeOpencode.test-support.ts). */
const opencodeServices = (options: Partial<FakeOpencodeOptions> = {}) => {
  const generation = options.generation ?? 1;
  const session = generation === 1 ? v1Session(SRC, "/src") : v2Session(SRC, "/src");
  return fakeOpencode({ generation, sessions: { [SRC]: session }, ...options }).ports.services;
};

const output = (): SpawnPlanOutput => ({
  command: "opencode",
  args: [],
  env: [],
});

const input = {
  paneId: "pane-3",
  workspace: { id: "ws-1", instance: "workspace-instance-1" },
  cwd: "/repo",
};

describe("opencode plugin hooks", () => {
  it("injects KeepDeck's plugin DIRECTORY via a MERGING per-invocation config", async () => {
    // One directory, under the legacy `plugin` key: the one shape both
    // opencode generations load. It rides an additive array — the user's own
    // plugins are not replaced.
    const agent = activate("/App/resources");
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(out.args).toEqual([]);
    const env = Object.fromEntries(out.env);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      plugin: ["/App/resources/keepdeck-plugin"],
    });
  });

  it("injected MCP servers share the reporter's config var, not a second one", async () => {
    // opencode reads OPENCODE_CONFIG_CONTENT once: a second assignment would
    // silently drop whichever came first.
    const agent = activate("/App/resources");
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
    const out = output();
    await agent.hooks["spawn.plan"]!({ ...input, mcp }, out);

    const assignments = out.env.filter(
      ([key]) => key === "OPENCODE_CONFIG_CONTENT",
    );
    expect(assignments).toHaveLength(1);
    expect(JSON.parse(assignments[0]![1])).toEqual({
      plugin: ["/App/resources/keepdeck-plugin"],
      mcp: {
        keepdeck: {
          type: "local",
          command: ["/bin/keepdeck", "--mcp-shim", "/home/mcp.sock"],
          enabled: true,
        },
      },
    });
  });

  it("carries them on resume and fork too, not only on a fresh spawn", async () => {
    // All three hooks call the same helper, but only spawn was covered —
    // reverting either of the other two to the reporter-only call would have
    // passed every existing test.
    const agent = activate("/App/resources", opencodeServices());
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
    const carries = (out: SpawnPlanOutput) => {
      const assignments = out.env.filter(
        ([key]) => key === "OPENCODE_CONFIG_CONTENT",
      );
      expect(assignments).toHaveLength(1);
      return JSON.parse(assignments[0]![1]).mcp?.keepdeck?.command;
    };

    const resume = output();
    await agent.hooks["resume.plan"]!({ ...input, mcp, sessionId: "s" }, resume);
    expect(carries(resume)).toEqual([
      "/bin/keepdeck",
      "--mcp-shim",
      "/home/mcp.sock",
    ]);

    const fork = output();
    await agent.hooks["fork.plan"]!(
      { ...input, mcp, sessionId: SRC, sourceCwd: "/old" },
      fork,
    );
    expect(carries(fork)).toEqual([
      "/bin/keepdeck",
      "--mcp-shim",
      "/home/mcp.sock",
    ]);
  });

  /**
   * The property, rather than one carrier at a time. Three hooks used to
   * repeat the same staging by hand, and a carrier added to one and forgotten
   * in another is invisible: the pane comes up without its reporter, or
   * without its skills, and goes on looking like the ones that have them.
   * Asserting that all three stage IDENTICALLY outlives the list — a carrier
   * added tomorrow is covered without touching this test.
   */
  it("stages every launch alike — a fresh spawn, a resume and a fork", async () => {
    const agent = activate("/App/resources", opencodeServices());
    const shared = {
      ...input,
      mcp: {
        servers: [
          {
            name: "keepdeck",
            transport: "stdio" as const,
            command: "/bin/keepdeck",
            args: [],
          },
        ],
      },
      skills: {
        claudePluginDir: "/staged/claude-plugin",
        opencodeConfigDir: "/staged/opencode",
        skillsDir: "/staged/skills",
      },
    };

    const spawn = output();
    await agent.hooks["spawn.plan"]!(shared, spawn);
    const resume = output();
    await agent.hooks["resume.plan"]!({ ...shared, sessionId: "s" }, resume);
    const fork = output();
    await agent.hooks["fork.plan"]!(
      { ...shared, sessionId: SRC, sourceCwd: "/old" },
      fork,
    );

    // The arguments differ by design — only what a launch CARRIES is shared.
    expect(resume.env).toEqual(spawn.env);
    expect(fork.env).toEqual(spawn.env);
    expect(resume.envDefaults).toEqual(spawn.envDefaults);
    expect(fork.envDefaults).toEqual(spawn.envDefaults);
    // And it is not vacuously equal: staging really put something there.
    expect(spawn.env.length).toBeGreaterThan(0);
    expect(spawn.envDefaults?.length).toBeGreaterThan(0);
  });

  /**
   * The reporter cannot discover the mode: the TUI runs plugins in a worker
   * whose argv is the worker's own, and the effective config is identical
   * leaf for leaf whether the flag was passed or not. So the deck states its
   * own choice, per pane — a pane launched normally must go on surfacing the
   * approvals it really waits on.
   */
  it("tells the reporter when this pane's approvals are answered for it", async () => {
    const agent = activate("/App/resources");
    const skipped = output();
    await agent.hooks["spawn.plan"]!({ ...input, yolo: true }, skipped);
    expect(skipped.env).toContainEqual([
      "KEEPDECK_OPENCODE_SKIPS_APPROVALS",
      "1",
    ]);

    const normal = output();
    await agent.hooks["spawn.plan"]!({ ...input, yolo: false }, normal);
    expect(normal.env.map(([key]) => key)).not.toContain(
      "KEEPDECK_OPENCODE_SKIPS_APPROVALS",
    );
  });

  it("carries the servers even when the reporter file is missing", async () => {
    // Identity off must not take injection down with it — they are separate
    // features sharing one variable.
    const agent = activate(null);
    const out = output();
    await agent.hooks["spawn.plan"]!(
      {
        ...input,
        mcp: {
          servers: [
            {
              name: "keepdeck",
              transport: "stdio" as const,
              command: "/bin/keepdeck",
              args: [],
            },
          ],
        },
      },
      out,
    );
    const env = Object.fromEntries(out.env);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).mcp.keepdeck).toBeDefined();
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).plugin).toBeUndefined();
  });

  it("staged skills ride OPENCODE_CONFIG_DIR as an env DEFAULT, never an override", async () => {
    const agent = activate("/App/resources");
    const skills = {
      claudePluginDir: "/kd/staging/ws-1/claude-plugin",
      opencodeConfigDir: "/kd/staging/ws-1/opencode",
      skillsDir: "/kd/staging/ws-1/skills",
    };
    const out = output();
    await agent.hooks["spawn.plan"]!({ ...input, skills }, out);

    // A default, not plain env: the variable is opencode's whole config
    // home, and a user-set value must win over skills delivery.
    expect(Object.fromEntries(out.envDefaults ?? [])).toEqual({
      OPENCODE_CONFIG_DIR: "/kd/staging/ws-1/opencode",
      OPENCODE_TUI_CONFIG: "/App/resources/keepdeck-plugin/tui-v1.json",
    });
    const env = Object.fromEntries(out.env);
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
    // The reporter's own door is untouched.
    expect(env.OPENCODE_CONFIG_CONTENT).toBeDefined();

    const resume = output();
    await agent.hooks["resume.plan"]!({ ...input, skills, sessionId: "s" }, resume);
    expect(Object.fromEntries(resume.envDefaults ?? []).OPENCODE_CONFIG_DIR).toBe(
      "/kd/staging/ws-1/opencode",
    );

    // No skills — no config dir, on spawn AND resume alike.
    const bareSpawn = output();
    await agent.hooks["spawn.plan"]!(input, bareSpawn);
    expect(Object.fromEntries(bareSpawn.envDefaults ?? []).OPENCODE_CONFIG_DIR).toBeUndefined();
    const bareResume = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "s" }, bareResume);
    expect(Object.fromEntries(bareResume.envDefaults ?? []).OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(Object.fromEntries(bareResume.env).OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  it("gives a local 1.x pane KeepDeck's TUI plugin as an env DEFAULT, apart from the skills", async () => {
    // The TUI half tells the server half which session is on screen
    // (task-435). Its own variable, so a user who owns it loses only this —
    // and a default, so their value wins.
    const agent = activate("/App/resources");
    for (const hook of ["spawn.plan", "resume.plan"] as const) {
      const out = output();
      await agent.hooks[hook]!({ ...input, cliVersion: "1.19.3", sessionId: "s" }, out);
      expect(out.envDefaults).toEqual([
        ["OPENCODE_TUI_CONFIG", "/App/resources/keepdeck-plugin/tui-v1.json"],
      ]);
      expect(Object.fromEntries(out.env).OPENCODE_TUI_CONFIG).toBeUndefined();
    }
    // An unknown version runs as 1.x, observer included.
    const unknown = output();
    await agent.hooks["spawn.plan"]!(input, unknown);
    expect(Object.fromEntries(unknown.envDefaults ?? []).OPENCODE_TUI_CONFIG).toBeDefined();
  });

  it("gives the TUI plugin to nobody else: not 2.x, not a remote pane, not a broken install", async () => {
    const agent = activate("/App/resources");
    const v2 = output();
    await agent.hooks["spawn.plan"]!({ ...input, cliVersion: "opencode v2.1.2" }, v2);
    const remote = output();
    await agent.hooks["spawn.plan"]!(
      { ...input, target: { kind: "nativeServer", endpoint: "http://vps:4096" } },
      remote,
    );
    const broken = output();
    await activate(null).hooks["spawn.plan"]!(input, broken);
    for (const out of [v2, remote, broken]) {
      expect(Object.fromEntries(out.envDefaults ?? []).OPENCODE_TUI_CONFIG).toBeUndefined();
    }
  });

  it("hands 2.x its skills in the config, and never OPENCODE_CONFIG_DIR — there it replaces the user's", async () => {
    const agent = activate("/App/resources");
    const skills = {
      claudePluginDir: "/kd/staging/ws-1/claude-plugin",
      opencodeConfigDir: "/kd/staging/ws-1/opencode",
      skillsDir: "/kd/staging/ws-1/skills",
    };
    for (const hook of ["spawn.plan", "resume.plan"] as const) {
      const out = output();
      await agent.hooks[hook]!({ ...input, skills, sessionId: "s", cliVersion: "2.1.2" }, out);
      expect(out.envDefaults ?? [], hook).toEqual([]);
      const env = Object.fromEntries(out.env);
      expect(env.OPENCODE_CONFIG_DIR, hook).toBeUndefined();
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).skills, hook).toEqual(["/kd/staging/ws-1/skills"]);
    }

    // No skills — no key at all.
    const bare = output();
    await agent.hooks["spawn.plan"]!({ ...input, cliVersion: "2.1.2" }, bare);
    expect(JSON.parse(Object.fromEntries(bare.env).OPENCODE_CONFIG_CONTENT)).not.toHaveProperty("skills");
  });

  it("resumes with -s and still arms the reporter (catches /new)", async () => {
    const agent = activate("/App/resources");
    const out = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "ses_x" }, out);

    expect(out.args).toEqual(["-s", "ses_x"]);
    expect(Object.fromEntries(out.env).OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it("forks INTO the pane's directory and opens the clone by its own id — never with --fork", async () => {
    const agent = activate("/App/resources", opencodeServices());
    const out = output();
    await agent.hooks["fork.plan"]!(
      { ...input, cwd: "/new/target", sessionId: SRC, sourceCwd: "/src" },
      out,
    );

    expect(out.args).not.toContain("--fork");
    expect(out.args[0]).toBe("-s");
    expect(out.args[1]).not.toBe(SRC);
    expect(Object.fromEntries(out.env).OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it("a fork honors YOLO: the skip-permissions flag precedes the clone's id", async () => {
    const agent = activate("/App/resources", opencodeServices());
    const out = output();
    await agent.hooks["fork.plan"]!(
      { ...input, yolo: true, cwd: "/new/target", sessionId: SRC, sourceCwd: "/src" },
      out,
    );
    expect(out.args[0]).toBe("--dangerously-skip-permissions");
    expect(out.args[1]).toBe("-s");
    expect(out.args[2]).not.toBe(SRC);
  });

  it("refuses a fork it cannot land in the pane's directory — it never opens one in the source's", async () => {
    // A missing target, a failed copy: the hook throws, the host's alert says
    // why, and no pane runs the agent in another team's checkout.
    const missing = activate("/App/resources", opencodeServices({ exists: () => false }));
    await expect(
      missing.hooks["fork.plan"]!({ ...input, cwd: "/gone", sessionId: SRC, sourceCwd: "/src" }, output()),
    ).rejects.toThrow("The fork target /gone does not exist.");

    const broken = activate(
      "/App/resources",
      opencodeServices({
        answer: (run) => (run.args[0] === "import" ? { text: "error\r\n", code: 1 } : undefined),
      }),
    );
    await expect(
      broken.hooks["fork.plan"]!({ ...input, cwd: "/new/target", sessionId: SRC, sourceCwd: "/src" }, output()),
    ).rejects.toThrow("The copy failed");
  });

  it("degrades to a bare spawn when neither of our plugins resolves", async () => {
    const agent = activate(null);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);
    expect(out.env).toEqual([]);
    expect(out.args).toEqual([]);
  });

  it("takes mail through the courier and is never typed at", () => {
    // Both halves of the same decision. `mail` is what puts this agent on
    // the labelled channel at all; `wake: "bridge"` is what stops the deck
    // typing a nudge into the pane when nothing else would start a turn —
    // the courier is already inside the process and can start one properly.
    const agent = activate("/App/resources");
    expect(agent.status?.mail?.channels).toEqual([
      { event: "mail.ask", atTurnEnd: true },
      { event: "mail.ask.tool", atTurnEnd: false },
    ]);
    expect(agent.status?.wake).toBe("bridge");
  });

  it("gives a 2.x pane a server of its own on spawn, resume and fork, and a 1.x pane none", async () => {
    // Without it every 2.x pane joins one background service that loaded the
    // plugin with the first pane's environment; 1.x exits on the flag.
    const agent = activate("/App/resources", opencodeServices({ generation: 2 }));
    const v2 = { ...input, cliVersion: "opencode v2.1.2" };

    const spawn = output();
    await agent.hooks["spawn.plan"]!(v2, spawn);
    const resume = output();
    await agent.hooks["resume.plan"]!({ ...v2, sessionId: "ses_x" }, resume);
    const fork = output();
    await agent.hooks["fork.plan"]!({ ...v2, sessionId: SRC, sourceCwd: "/repo" }, fork);
    for (const plan of [spawn, resume, fork]) expect(plan.args).toContain("--standalone");

    const v1 = output();
    await agent.hooks["spawn.plan"]!({ ...input, cliVersion: "1.19.3" }, v1);
    expect(v1.args).not.toContain("--standalone");
  });

  it("puts 2.x's own server ahead of the YOLO flag, and the session after both", async () => {
    // The order every 2.x launch has had since task-376: a reshuffle here is
    // no visible failure, so it is pinned exactly rather than by `toContain`.
    const agent = activate("/App/resources");
    const v2 = { ...input, cliVersion: "opencode v2.1.2", yolo: true };

    const spawn = output();
    await agent.hooks["spawn.plan"]!(v2, spawn);
    expect(spawn.args).toEqual(["--standalone", "--dangerously-skip-permissions"]);

    const resume = output();
    await agent.hooks["resume.plan"]!({ ...v2, sessionId: "ses_x" }, resume);
    expect(resume.args).toEqual(["--standalone", "--dangerously-skip-permissions", "-s", "ses_x"]);
  });

  it("names a 2.x pane's resumed session in its environment too, and only there", async () => {
    // Under --standalone the plugin runs in a child that never sees `-s`
    // (task-382); the environment reaches it. 1.x reads its own arguments,
    // and a fresh spawn has no session to name.
    const agent = activate("/App/resources");
    const v2 = { ...input, cliVersion: "opencode v2.1.2" };

    const resume = output();
    await agent.hooks["resume.plan"]!({ ...v2, sessionId: "ses_r" }, resume);
    expect(resume.args).toEqual(["--standalone", "-s", "ses_r"]);
    expect(Object.fromEntries(resume.env)[OPENCODE_SESSION_ENV]).toBe("ses_r");
    // The name the plugin reads (resources/keepdeck-plugin/opencode-v2.js).
    expect(OPENCODE_SESSION_ENV).toBe("KEEPDECK_OPENCODE_SESSION");

    const v1 = output();
    await agent.hooks["resume.plan"]!({ ...input, cliVersion: "1.19.3", sessionId: "ses_r" }, v1);
    expect(v1.args).toEqual(["-s", "ses_r"]);
    expect(Object.fromEntries(v1.env).KEEPDECK_OPENCODE_SESSION).toBeUndefined();

    const spawn = output();
    await agent.hooks["spawn.plan"]!(v2, spawn);
    expect(Object.fromEntries(spawn.env).KEEPDECK_OPENCODE_SESSION).toBeUndefined();
  });

  it("gives a remote pane nothing local: no config dir, no skills, on either generation", async () => {
    // `attach` loads none of it, so a config dir handed to a thin client was a
    // directory nobody opens. The plugin and servers still travel (see below).
    const agent = activate("/App/resources");
    const target = { kind: "nativeServer" as const, endpoint: "http://vps:4096" };
    const skills = {
      claudePluginDir: "/kd/staging/ws-1/claude-plugin",
      opencodeConfigDir: "/kd/staging/ws-1/opencode",
      skillsDir: "/kd/staging/ws-1/skills",
    };

    for (const cliVersion of ["1.19.3", "opencode v2.1.2", undefined]) {
      const spawn = output();
      await agent.hooks["spawn.plan"]!({ ...input, target, skills, cliVersion }, spawn);
      expect(spawn.envDefaults ?? []).toEqual([]);
      const config = JSON.parse(Object.fromEntries(spawn.env).OPENCODE_CONFIG_CONTENT);
      expect(config).not.toHaveProperty("skills");
      expect(config.plugin).toEqual(["/App/resources/keepdeck-plugin"]);
    }
  });

  it("YOLO adds the skip-permissions flag on spawn and resume alike", async () => {
    const agent = activate("/App/resources");

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, yolo: true }, spawn);
    expect(spawn.args).toEqual(["--dangerously-skip-permissions"]);
    // The reporter's env injection is independent of the mode.
    expect(Object.fromEntries(spawn.env).OPENCODE_CONFIG_CONTENT).toBeDefined();

    const resume = output();
    await agent.hooks["resume.plan"]!(
      { ...input, yolo: true, sessionId: "ses_x" },
      resume,
    );
    expect(resume.args).toEqual([
      "--dangerously-skip-permissions",
      "-s",
      "ses_x",
    ]);
  });

  it("on a nativeServer target, spawn/resume/fork become `attach <ep>` (drop -s/--fork)", async () => {
    const agent = activate("/App/resources");
    const target = { kind: "nativeServer" as const, endpoint: "http://vps:4096" };

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, target }, spawn);
    expect(spawn.args).toEqual(["attach", "http://vps:4096"]);

    const resume = output();
    await agent.hooks["resume.plan"]!(
      { ...input, target, sessionId: "ses_x" },
      resume,
    );
    // Remote REPLACES the local resume args: no -s, just attach (session
    // continuity is the server's job).
    expect(resume.args).toEqual(["attach", "http://vps:4096"]);
    expect(resume.args).not.toContain("-s");

    // Remote fork short-circuits before any store surgery — no services stub
    // needed, and no --fork (forking is server-side once attached).
    const fork = output();
    await agent.hooks["fork.plan"]!(
      { ...input, target, cwd: "/t", sessionId: "ses_x", sourceCwd: "/src" },
      fork,
    );
    expect(fork.args).toEqual(["attach", "http://vps:4096"]);
    expect(fork.args).not.toContain("--fork");

    // The config still travels — the same staging serves every launch. What it
    // does NOT do is arrive anywhere: measured on a rig, an `attach` client
    // does not load the plugins its own `OPENCODE_CONFIG_CONTENT` names (a
    // probe placed there never initialises over a whole turn, while the same
    // probe in an ordinary TUI marks at startup). The agent runs on the
    // server, which takes plugins from its OWN environment.
    //
    // So a remote pane reports nothing to the deck: no binding, no turn edges,
    // no usage, no courier. The remote path is unfinished and this is one of
    // the ways. Said here rather than asserted — this test can only see the
    // envelope leave, and what happens to it was established elsewhere.
    expect(Object.fromEntries(spawn.env).OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it("honors YOLO on remote attach (global flag, last)", async () => {
    const agent = activate("/App/resources");
    const target = { kind: "nativeServer" as const, endpoint: "http://vps:4096" };
    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, target, yolo: true }, spawn);
    expect(spawn.args).toEqual([
      "attach",
      "http://vps:4096",
      "--dangerously-skip-permissions",
    ]);
  });
});

describe("opencode plugin identity", () => {
  it("ships the official two-tone mark: block cursor under the frame", () => {
    const agent = activate(null);
    expect(agent.icon?.viewBox).toBe("0 0 240 300");
    expect(agent.icon?.paths.map((p) => p.color)).toEqual([
      "#4B4646",
      "#F1ECEC",
    ]);
  });
});

describe("opencode plugin — warming the config dir", () => {
  const CFG = "/cfg/ws-1";

  /** A services stub that answers as a dir with a manifest and nothing
   * installed — the state a fresh workspace is in — and records runs. */
  function warmServices() {
    const runOnce = vi.fn(async (_request: { key: string; command: string }) => ({
      ran: true,
      ok: true,
      said: "",
    }));
    return {
      runOnce,
      services: {
        fs: {
          readFile: async (path: string) => {
            if (path === `${CFG}/package.json`) {
              return { path, text: "{}", isBinary: false, size: 2, truncated: false, readBytes: 2 };
            }
            throw new Error(`ENOENT: ${path}`);
          },
        },
        exec: { runOnce },
      },
    };
  }

  const withSkills = {
    ...input,
    skills: { opencodeConfigDir: CFG, skillsDir: "/s", claudePluginDir: "/c" },
  };

  it("bootstraps a local pane's config dir before it spawns", async () => {
    const { runOnce, services } = warmServices();
    const agent = activate("/App/resources", services);

    await agent.hooks["spawn.plan"]!(withSkills, output());

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce.mock.calls[0][0]).toMatchObject({ key: CFG, command: "opencode" });
  });

  it("warms nothing for 2.x, which is given no config dir", async () => {
    const { runOnce, services } = warmServices();
    const agent = activate("/App/resources", services);

    await agent.hooks["spawn.plan"]!({ ...withSkills, cliVersion: "2.1.2" }, output());

    expect(runOnce).not.toHaveBeenCalled();
  });

  it("warms nothing when the pane gets no staged skills", async () => {
    // No staged skills means no OPENCODE_CONFIG_DIR in the plan either, so
    // the pane lives in the CLI's global home — there is no per-workspace
    // dir to bootstrap, and asking for one would name a path nobody uses.
    const { runOnce, services } = warmServices();
    const agent = activate("/App/resources", services);

    await agent.hooks["spawn.plan"]!(input, output());

    expect(runOnce).not.toHaveBeenCalled();
  });

  it("leaves a remote pane's workspace alone — it opens no local config dir", async () => {
    // `attach` runs the agent on the server and this process is a thin
    // client: the local dir is one nothing here will read, so warming it
    // would spend a minute on a directory this pane never opens.
    const { runOnce, services } = warmServices();
    const agent = activate("/App/resources", services);
    const target = { kind: "nativeServer" as const, endpoint: "http://vps:4096" };

    await agent.hooks["spawn.plan"]!({ ...withSkills, target }, output());

    expect(runOnce).not.toHaveBeenCalled();
  });
});
