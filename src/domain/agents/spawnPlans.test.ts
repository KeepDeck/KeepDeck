import { describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  buildSpawnPlan,
  EMPTY_SPAWN_CONTEXT,
  type SpawnPlanContext,
} from "./spawnPlans";

const ctx: SpawnPlanContext = {
  bridgeDir: "/bridge/run-1",
  claudeHookArgs: ["--settings", '{"hooks":{"SessionStart":[…]}}'],
  codexHookArgs: ["-c", "hooks.SessionStart=[…]", "-c", "hooks.state.k.trusted_hash=abc"],
  opencodePluginPath: "/App.app/Resources/session-reporter.js",
};

const mint = () => "11111111-2222-3333-4444-555555555555";
const mintToken = () => "token-1";
const mints = { mintId: mint, mintToken };

const bridgeEnv = (paneId: string): [string, string] => [
  "KEEPDECK_BRIDGE",
  JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    dir: "/bridge/run-1",
    pane: paneId,
    token: "token-1",
  }),
];

describe("buildSpawnPlan — claude (assigned identity + hook reporter)", () => {
  it("mints and assigns the session id, arming the /clear reporter", () => {
    const plan = buildSpawnPlan("claude", "pane-1", ctx, mints);
    expect(plan.args).toEqual([...ctx.claudeHookArgs!, "--session-id", mint()]);
    expect(plan.sessionId).toBe(mint());
    expect(plan.env).toEqual([bridgeEnv("pane-1")]);
    expect(plan.token).toBe("token-1");
  });

  it("resume reuses the recorded id and keeps the reporter armed", () => {
    const plan = buildSpawnPlan("claude", "pane-1", ctx, {
      resumeId: "old-id",
      ...mints,
    });
    expect(plan.args).toEqual([...ctx.claudeHookArgs!, "--resume", "old-id"]);
    expect(plan.sessionId).toBeUndefined();
    expect(plan.token).toBe("token-1");
  });

  it("degrades to assignment-only without the hook resource", () => {
    const plan = buildSpawnPlan("claude", "pane-1", EMPTY_SPAWN_CONTEXT, mints);
    expect(plan.args).toEqual(["--session-id", mint()]);
    expect(plan.env).toEqual([]);
    expect(plan.token).toBeUndefined();
  });
});

describe("buildSpawnPlan — codex (hook reporter)", () => {
  it("arms the SessionStart hook and the bridge env", () => {
    const plan = buildSpawnPlan("codex", "pane-2", ctx, mints);
    expect(plan.args).toEqual(ctx.codexHookArgs);
    expect(plan.env).toEqual([bridgeEnv("pane-2")]);
    expect(plan.token).toBe("token-1");
  });

  it("puts the global -c flags BEFORE the resume subcommand", () => {
    const plan = buildSpawnPlan("codex", "pane-2", ctx, { resumeId: "uuid-9", ...mints });
    expect(plan.args).toEqual([...ctx.codexHookArgs!, "resume", "uuid-9"]);
  });

  it("degrades to a bare spawn when the hook is unavailable", () => {
    const plan = buildSpawnPlan("codex", "pane-2", EMPTY_SPAWN_CONTEXT, mints);
    expect(plan.args).toEqual([]);
    expect(plan.env).toEqual([]);
    expect(plan.token).toBeUndefined();
  });
});

describe("buildSpawnPlan — opencode (plugin reporter)", () => {
  it("injects the plugin via a MERGING per-invocation config", () => {
    const plan = buildSpawnPlan("opencode", "pane-3", ctx, mints);
    expect(plan.args).toEqual([]);
    const env = Object.fromEntries(plan.env);
    expect(JSON.parse(env.KEEPDECK_BRIDGE)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      dir: "/bridge/run-1",
      pane: "pane-3",
      token: "token-1",
    });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      plugin: ["/App.app/Resources/session-reporter.js"],
    });
    expect(plan.token).toBe("token-1");
  });

  it("resumes with -s and still arms the plugin (catches /new)", () => {
    const plan = buildSpawnPlan("opencode", "pane-3", ctx, { resumeId: "ses_x", ...mints });
    expect(plan.args).toEqual(["-s", "ses_x"]);
    expect(Object.fromEntries(plan.env).OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it("degrades to a bare spawn without the plugin or the bridge", () => {
    expect(buildSpawnPlan("opencode", "pane-3", EMPTY_SPAWN_CONTEXT, mints).env).toEqual([]);
    const noBridge = buildSpawnPlan("opencode", "pane-3", { ...ctx, bridgeDir: "" }, mints);
    expect(noBridge.env).toEqual([]);
    expect(noBridge.token).toBeUndefined();
  });
});

describe("buildSpawnPlan — the open id set", () => {
  it("a catalog entry without a resume recipe still resumes via the static one", () => {
    // Plugin-contributed catalog entries carry no resumePrefix yet — resume
    // must fall through to the built-in recipe, not silently spawn fresh.
    const sparse = [
      { id: "codex", label: "Codex", command: "codex", installed: true, path: null },
    ];
    const plan = buildSpawnPlan("codex", "pane-2", ctx, {
      resumeId: "uuid-9",
      agents: sparse,
      ...mints,
    });
    expect(plan.args).toEqual([...ctx.codexHookArgs!, "resume", "uuid-9"]);
  });

  it("an unknown agent id gets a bare plan, no identity mechanism", () => {
    const plan = buildSpawnPlan("gemini", "pane-4", ctx, mints);
    expect(plan).toEqual({ args: [], env: [] });
    const resume = buildSpawnPlan("gemini", "pane-4", ctx, {
      resumeId: "x",
      ...mints,
    });
    // No recipe for an unknown agent → fresh spawn, never guessed flags.
    expect(resume.args).toEqual([]);
  });
});
