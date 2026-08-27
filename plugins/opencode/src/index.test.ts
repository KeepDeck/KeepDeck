import { describe, expect, it, vi } from "vitest";
import type {
  AgentContribution,
  PluginContext,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import plugin from "./index";

/** Activate against a minimal fake ctx; returns the registered agent. An
 * optional `services` stub is threaded through for the fork hook.
 *
 * `reporterPath` stands for the resources DIRECTORY: the plugin injects two
 * files from it now, and a stub answering one path for every name would hide
 * a mix-up between them. Null means nothing resolves, as on a broken install. */
function activate(
  reporterPath: string | null,
  services?: unknown,
): AgentContribution {
  let agent: AgentContribution | undefined;
  plugin.activate({
    agents: { register: (a: AgentContribution) => ((agent = a), { dispose() {} }) },
    resources: {
      path: async (name: string) =>
        reporterPath === null ? null : reporterPath.replace(/[^/]+$/, name),
    },
    log: { info() {}, warn() {}, error() {} },
    notify: () => {},
    ...(services ? { services } : {}),
  } as unknown as PluginContext);
  if (!agent) throw new Error("plugin registered no agent");
  return agent;
}

/** A services stub for the fork hook. `targetMissing` makes the target look
 * un-provisioned (native fallback); otherwise `sessions.spawn` fakes
 * export→import so the relocating recipe returns a minted id. */
function forkServices(opts?: { targetMissing?: boolean; importFails?: boolean }) {
  // A realistic (guard-valid) exported session id; the reminted clone id is
  // what fork.plan resumes. Distinct from the input `ses_x` passed to export.
  const SRC = "ses_0db9e24cbffej1WlbsRKynAHf3";
  const writes = new Map<string, string>();
  const enc = (s: string) => new TextEncoder().encode(s);
  return {
    fs: {
      readDir: async (path: string) => {
        if (opts?.targetMissing) throw new Error(`ENOENT: ${path}`);
        return [];
      },
    },
    fsWrite: { writeFile: async (p: string, t: string) => void writes.set(p, t) },
    sessions: {
      spawn: async (
        o: { args: string[]; cwd?: string },
        onEvent: (e: { type: "output"; bytes: Uint8Array } | { type: "exit"; code: number | null }) => void,
      ) => {
        queueMicrotask(() => {
          if (o.args[0] === "export") {
            const doc = { info: { id: SRC, directory: "/src", title: "t" }, messages: [] };
            onEvent({ type: "output", bytes: enc(`Exporting session: ${SRC}\r\n${JSON.stringify(doc)}`) });
            onEvent({ type: "exit", code: 0 });
          } else {
            const id = JSON.parse(writes.get(o.args[1]) ?? "{}").info.id as string;
            onEvent({ type: "output", bytes: enc(opts?.importFails ? "error\r\n" : `Imported session: ${id}\r\n`) });
            onEvent({ type: "exit", code: opts?.importFails ? 1 : 0 });
          }
        });
        return { id: "h", write: async () => {}, resize: async () => {}, close: async () => {} };
      },
    },
  };
}

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
  it("injects BOTH of KeepDeck's plugins via a MERGING per-invocation config", async () => {
    // Two files, two jobs: the reporter talks about this pane and asks
    // nothing, the courier carries mail into the session and is the only one
    // that asks. They ride one additive array — the user's own plugins are
    // not replaced.
    const agent = activate("/App/resources/session-reporter.js");
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(out.args).toEqual([]);
    const env = Object.fromEntries(out.env);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      plugin: [
        "/App/resources/session-reporter.js",
        "/App/resources/mail-courier.js",
      ],
    });
  });

  it("injected MCP servers share the reporter's config var, not a second one", async () => {
    // opencode reads OPENCODE_CONFIG_CONTENT once: a second assignment would
    // silently drop whichever came first.
    const agent = activate("/App/resources/session-reporter.js");
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
      plugin: [
        "/App/resources/session-reporter.js",
        "/App/resources/mail-courier.js",
      ],
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
    const agent = activate("/App/resources/session-reporter.js");
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
      { ...input, mcp, sessionId: "s", sourceCwd: "/old" },
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
    const agent = activate("/App/resources/session-reporter.js");
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
      { ...shared, sessionId: "s", sourceCwd: "/old" },
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
    const agent = activate("/App/resources/session-reporter.js");
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
    const agent = activate("/App/resources/session-reporter.js");
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

    // No skills — no default, on spawn AND resume alike.
    const bareSpawn = output();
    await agent.hooks["spawn.plan"]!(input, bareSpawn);
    expect(bareSpawn.envDefaults ?? []).toEqual([]);
    const bareResume = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "s" }, bareResume);
    expect(bareResume.envDefaults ?? []).toEqual([]);
    expect(Object.fromEntries(bareResume.env).OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  it("resumes with -s and still arms the reporter (catches /new)", async () => {
    const agent = activate("/App/resources/session-reporter.js");
    const out = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "ses_x" }, out);

    expect(out.args).toEqual(["-s", "ses_x"]);
    expect(Object.fromEntries(out.env).OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it("relocating fork: an EXISTING target imports a clone, resumes its NEW id (no --fork)", async () => {
    const agent = activate("/App/resources/session-reporter.js", forkServices());
    const out = output();
    await agent.hooks["fork.plan"]!(
      { ...input, cwd: "/new/target", sessionId: "ses_x", sourceCwd: "/src" },
      out,
    );

    // The relocated clone is resumed by its minted id — never the source, and
    // NOT via native --fork (which would re-home to the source dir).
    expect(out.args).not.toContain("--fork");
    expect(out.args[0]).toBe("-s");
    expect(out.args[1]).not.toBe("ses_x");
    expect(Object.fromEntries(out.env).OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it("relocating fork honors YOLO: skip-permissions flag precedes the resumed clone id", async () => {
    const agent = activate("/App/resources/session-reporter.js", forkServices());
    const out = output();
    await agent.hooks["fork.plan"]!(
      { ...input, yolo: true, cwd: "/new/target", sessionId: "ses_x", sourceCwd: "/src" },
      out,
    );
    expect(out.args[0]).toBe("--dangerously-skip-permissions");
    expect(out.args[1]).toBe("-s");
    expect(out.args[2]).not.toBe("ses_x"); // the relocated clone id, not the source
    expect(out.args).not.toContain("--fork");
  });

  it("falls back to native -s --fork when the target isn't provisioned yet", async () => {
    const agent = activate("/App/resources/session-reporter.js", forkServices({ targetMissing: true }));
    const out = output();
    await agent.hooks["fork.plan"]!(
      { ...input, cwd: "/future/worktree", sessionId: "ses_x", sourceCwd: "/x" },
      out,
    );
    expect(out.args).toEqual(["-s", "ses_x", "--fork"]);

    // The YOLO flag stays global/first even on the fallback path.
    const yolo = output();
    await agent.hooks["fork.plan"]!(
      { ...input, yolo: true, cwd: "/future/worktree", sessionId: "ses_x", sourceCwd: "/x" },
      yolo,
    );
    expect(yolo.args[0]).not.toBe("-s");
    expect(yolo.args.slice(-3)).toEqual(["-s", "ses_x", "--fork"]);
  });

  it("falls back to native -s --fork when the relocating recipe FAILS (no hard-fail)", async () => {
    const agent = activate("/App/resources/session-reporter.js", forkServices({ importFails: true }));
    const out = output();
    await agent.hooks["fork.plan"]!(
      { ...input, cwd: "/new/target", sessionId: "ses_x", sourceCwd: "/src" },
      out,
    );
    // A recipe error degrades to native, never throws out of the hook.
    expect(out.args).toEqual(["-s", "ses_x", "--fork"]);
  });

  it("degrades to a bare spawn when neither of our plugins resolves", async () => {
    const agent = activate(null);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);
    expect(out.env).toEqual([]);
    expect(out.args).toEqual([]);
  });

  it("takes mail through the courier and is never typed at", () => {
    // Both halves of the same decision. `renderMail` is what puts this agent
    // on the labelled channel at all; `wake: "bridge"` is what stops the deck
    // typing a nudge into the pane when nothing else would start a turn —
    // the courier is already inside the process and can start one properly.
    const agent = activate("/App/resources/session-reporter.js");
    expect(agent.status?.renderMail).toBeDefined();
    expect(agent.status?.wake).toBe("bridge");
  });

  it("YOLO adds the skip-permissions flag on spawn and resume alike", async () => {
    const agent = activate("/App/resources/session-reporter.js");
    expect(agent.supportsYolo).toBeUndefined();

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

  it("does not duplicate manifest remote support at runtime", () => {
    expect(activate(null).remote).toBeUndefined();
  });

  it("on a nativeServer target, spawn/resume/fork become `attach <ep>` (drop -s/--fork)", async () => {
    const agent = activate("/App/resources/session-reporter.js");
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
    const agent = activate("/App/resources/session-reporter.js");
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
            if (path === `${CFG}/package.json`) return { text: "{}" };
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
    const agent = activate("/App/resources/session-reporter.js", services);

    await agent.hooks["spawn.plan"]!(withSkills as never, output());

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce.mock.calls[0][0]).toMatchObject({ key: CFG, command: "opencode" });
  });

  it("leaves a remote pane's workspace alone — it opens no local config dir", async () => {
    // `attach` runs the agent on the server and this process is a thin
    // client: the local dir is one nothing here will read, so warming it
    // would spend a minute on a directory this pane never opens.
    const { runOnce, services } = warmServices();
    const agent = activate("/App/resources/session-reporter.js", services);
    const target = { kind: "nativeServer" as const, endpoint: "http://vps:4096" };

    await agent.hooks["spawn.plan"]!({ ...withSkills, target } as never, output());

    expect(runOnce).not.toHaveBeenCalled();
  });
});
