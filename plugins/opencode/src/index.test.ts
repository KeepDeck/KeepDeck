import { describe, expect, it } from "vitest";
import type {
  AgentContribution,
  PluginContext,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import plugin from "./index";

/** Activate against a minimal fake ctx; returns the registered agent. An
 * optional `services` stub is threaded through for the fork hook. */
function activate(
  reporterPath: string | null,
  services?: unknown,
): AgentContribution {
  let agent: AgentContribution | undefined;
  plugin.activate({
    agents: { register: (a: AgentContribution) => ((agent = a), { dispose() {} }) },
    resources: { path: async () => reporterPath },
    log: { info() {}, warn() {}, error() {} },
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

  it("degrades to a bare spawn when the reporter is missing", async () => {
    const agent = activate(null);
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);
    expect(out.env).toEqual([]);
    expect(out.args).toEqual([]);
  });

  it("YOLO adds the skip-permissions flag on spawn and resume alike", async () => {
    const agent = activate("/App/resources/session-reporter.js");
    expect(agent.supportsYolo).toBe(true);

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
