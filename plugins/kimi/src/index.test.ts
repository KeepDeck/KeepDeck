import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentContribution,
  PluginContext,
  PluginSessionEvent,
  SettingsSectionContribution,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import plugin, { setupNotification } from "./index";

interface ActivationOptions {
  manifestPath?: string | null;
  installedPlugins?: unknown[];
}

function activate(options: ActivationOptions = {}) {
  const manifestPath =
    options.manifestPath === undefined
      ? "/App/Kimi/kimi.plugin.json"
      : options.manifestPath;
  let agent: AgentContribution | undefined;
  let settings: SettingsSectionContribution | undefined;
  const disposable = () => ({ dispose() {} });
  const close = vi.fn(async () => {});
  const notify = vi.fn();
  const spawn = options.installedPlugins
    ? vi.fn(
        async (
          _options: unknown,
          onEvent: (event: PluginSessionEvent) => void,
        ) => {
          onEvent({
            type: "output",
            bytes: new TextEncoder().encode(
              `Kimi server: http://127.0.0.1:64999/#token=test-token\r\n`,
            ),
          });
          return {
            id: "setup",
            write: vi.fn(async () => {}),
            resize: vi.fn(async () => {}),
            close,
          };
        },
      )
    : vi.fn(async () => {
        throw new Error("kimi unavailable in unit test");
      });
  const ctx = {
    agents: {
      register: vi.fn((entry: AgentContribution) => {
        agent = entry;
        return disposable();
      }),
    },
    resources: { path: vi.fn(async () => manifestPath) },
    services: {
      sessions: { spawn },
    },
    settings: {
      registerSection: vi.fn((section: SettingsSectionContribution) => {
        settings = section;
        return disposable();
      }),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    notify,
  } as unknown as PluginContext;
  return Promise.resolve(plugin.activate(ctx)).then(() => {
    if (!agent || !settings) {
      throw new Error("Kimi plugin did not register its surfaces");
    }
    return { agent, settings, ctx, notify };
  });
}

const output = (): SpawnPlanOutput => ({ command: "kimi", args: [], env: [] });
const input = {
  paneId: "pane-k",
  workspace: { id: "ws-1", instance: "workspace-instance-1" },
  cwd: "/repo",
};

describe("Kimi CLI plugin", () => {
  afterEach(async () => {
    await plugin.deactivate?.();
    vi.unstubAllGlobals();
  });

  it("registers the Kimi identity and an inert fresh PTY plan", async () => {
    const { agent } = await activate();
    const out = output();
    await agent.hooks["spawn.plan"]!(input, out);

    expect(agent).toMatchObject({
      id: "kimi",
      label: "Kimi Code",
      detect: { bin: "kimi" },
    });
    expect(out).toEqual({ command: "kimi", args: [], env: [] });
  });

  it("uses Kimi's documented exact-session restore flag", async () => {
    const { agent } = await activate();
    const out = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "session_123" }, out);
    expect(out.args).toEqual(["--session", "session_123"]);
  });

  it("staged skills add --skills-dir on spawn and resume, absent otherwise", async () => {
    const { agent } = await activate();
    const skills = {
      claudePluginDir: "/kd/staging/ws-1/claude-plugin",
      opencodeConfigDir: "/kd/staging/ws-1/opencode",
      skillsDir: "/kd/staging/ws-1/skills",
    };

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, skills }, spawn);
    expect(spawn.args).toEqual(["--skills-dir", "/kd/staging/ws-1/skills"]);

    const resume = output();
    await agent.hooks["resume.plan"]!(
      { ...input, skills, sessionId: "session_123" },
      resume,
    );
    expect(resume.args).toEqual([
      "--skills-dir",
      "/kd/staging/ws-1/skills",
      "--session",
      "session_123",
    ]);

    // The "absent otherwise" half: no skills means the flag must not appear
    // at all — kimi's --skills-dir REPLACES its auto-discovery, so an empty
    // one would hide the user's own skills.
    const bareSpawn = output();
    await agent.hooks["spawn.plan"]!(input, bareSpawn);
    expect(bareSpawn.args).not.toContain("--skills-dir");

    const bareResume = output();
    await agent.hooks["resume.plan"]!({ ...input, sessionId: "session_123" }, bareResume);
    expect(bareResume.args).toEqual(["--session", "session_123"]);
  });

  it("YOLO adds --yolo on spawn and resume alike", async () => {
    const { agent } = await activate();
    expect(agent.supportsYolo).toBe(true);

    const spawn = output();
    await agent.hooks["spawn.plan"]!({ ...input, yolo: true }, spawn);
    expect(spawn.args).toEqual(["--yolo"]);

    const resume = output();
    await agent.hooks["resume.plan"]!(
      { ...input, yolo: true, sessionId: "session_123" },
      resume,
    );
    expect(resume.args).toEqual(["--yolo", "--session", "session_123"]);
  });

  it("registers plugin-owned setup UI even when its bundled resource is missing", async () => {
    const { settings } = await activate({ manifestPath: null });
    expect(settings.label).toBe("Kimi Code");
    expect(settings.fields).toHaveLength(1);
    expect(settings.fields[0]).toMatchObject({ kind: "custom", key: "setup" });
  });

  it("ships the official K-and-blue-accent product mark as path-only data", async () => {
    const { agent } = await activate();
    expect(agent.icon?.viewBox).toBe("0 0 24 20");
    expect(agent.icon?.paths).toHaveLength(2);
    expect(agent.icon?.paths[0].color).toBeUndefined();
    expect(agent.icon?.paths[1].color).toBe("#1783FF");
  });

  it("notifies on launch when Kimi confirms the companion is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, msg: "", data: [] }),
      })),
    );
    const { notify } = await activate({ installedPlugins: [] });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith({
        title: "Setup required",
        body: "Configure Kimi Code in Settings to restore sessions after KeepDeck restarts.",
        severity: "warning",
        tag: "setup-required",
      });
    });
  });

  it("does not turn a failed check into a false setup warning", async () => {
    const { notify } = await activate();
    await vi.waitFor(() => {
      expect(notify).not.toHaveBeenCalled();
    });
  });

  it("only creates setup notifications for actionable states", () => {
    expect(
      setupNotification({
        kind: "configured",
        operation: null,
        version: "1.0.0",
      }),
    ).toBeNull();
    expect(
      setupNotification({
        kind: "error",
        operation: null,
        message: "kimi not found",
        failedOperation: "check",
      }),
    ).toBeNull();
  });
});
