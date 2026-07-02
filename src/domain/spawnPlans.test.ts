import { describe, expect, it } from "vitest";
import { buildSpawnPlan, EMPTY_SPAWN_CONTEXT, type SpawnPlanContext } from "./spawnPlans";

const ctx: SpawnPlanContext = {
  spoolDir: "/spool",
  codexHookArgs: ["-c", "hooks.SessionStart=[…]", "-c", "hooks.state.k.trusted_hash=abc"],
  opencodePluginPath: "/App.app/Resources/session-reporter.js",
};

const mint = () => "11111111-2222-3333-4444-555555555555";

describe("buildSpawnPlan — claude (assigned identity)", () => {
  it("mints and assigns the session id at spawn", () => {
    const plan = buildSpawnPlan("claude", "pane-1", ctx, { mintId: mint });
    expect(plan.args).toEqual(["--session-id", mint()]);
    expect(plan.sessionId).toBe(mint());
    expect(plan.env).toEqual([]); // no reporter needed — the id is ours
  });

  it("resume reuses the recorded id and mints nothing", () => {
    const plan = buildSpawnPlan("claude", "pane-1", ctx, {
      resumeId: "old-id",
      mintId: mint,
    });
    expect(plan.args).toEqual(["--resume", "old-id"]);
    expect(plan.sessionId).toBeUndefined();
  });
});

describe("buildSpawnPlan — codex (hook reporter)", () => {
  it("arms the SessionStart hook and the reporter env", () => {
    const plan = buildSpawnPlan("codex", "pane-2", ctx);
    expect(plan.args).toEqual(ctx.codexHookArgs);
    expect(plan.env).toEqual([
      ["KEEPDECK_PANE_ID", "pane-2"],
      ["KEEPDECK_SPOOL", "/spool"],
    ]);
  });

  it("puts the global -c flags BEFORE the resume subcommand", () => {
    const plan = buildSpawnPlan("codex", "pane-2", ctx, { resumeId: "uuid-9" });
    expect(plan.args).toEqual([...ctx.codexHookArgs!, "resume", "uuid-9"]);
  });

  it("degrades to a bare spawn when the hook is unavailable", () => {
    const plan = buildSpawnPlan("codex", "pane-2", EMPTY_SPAWN_CONTEXT);
    expect(plan.args).toEqual([]);
    expect(plan.env).toEqual([]);
  });
});

describe("buildSpawnPlan — opencode (plugin reporter)", () => {
  it("injects the plugin via a MERGING per-invocation config", () => {
    const plan = buildSpawnPlan("opencode", "pane-3", ctx);
    expect(plan.args).toEqual([]);
    const env = Object.fromEntries(plan.env);
    expect(env.KEEPDECK_PANE_ID).toBe("pane-3");
    expect(env.KEEPDECK_SPOOL).toBe("/spool");
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      plugin: ["/App.app/Resources/session-reporter.js"],
    });
  });

  it("resumes with -s and still arms the plugin (catches /new)", () => {
    const plan = buildSpawnPlan("opencode", "pane-3", ctx, { resumeId: "ses_x" });
    expect(plan.args).toEqual(["-s", "ses_x"]);
    expect(Object.fromEntries(plan.env).OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it("degrades to a bare spawn without the plugin or the spool", () => {
    expect(buildSpawnPlan("opencode", "pane-3", EMPTY_SPAWN_CONTEXT).env).toEqual([]);
    const noSpool = buildSpawnPlan("opencode", "pane-3", { ...ctx, spoolDir: "" });
    expect(noSpool.env).toEqual([]);
  });
});
