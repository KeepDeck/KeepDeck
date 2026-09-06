// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SpawnSkillsInput } from "@keepdeck/plugin-api";
import { BRIDGE_PROTOCOL_VERSION } from "./plans";
import { buildResumeSpec, clearPanePlanError, peekPanePlanError, buildLivePaneSpec } from ".";
import {
  hostState,
  skillsState,
  stagedSkills,
  mcpAccess,
  plugins,
  runtime,
  ctx,
  W1,
  adopting,
  ws,
  settle,
  planHarness,
} from "./planTestSupport";

describe("building one plan through the agent hook", () => {
  const h = planHarness();

  beforeEach(() => h.reset());
  afterEach(() => h.teardown());

  it("builds through the hook and arms the bridge on top", async () => {
    h.register(adopting);
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();

    const plan = h.seen["pane-1"];
    expect(plan.command).toBe("claude");
    expect(plan.args).toEqual(["--settings", "{hook}"]);
    // Host-owned arming: the ONE bridge var, token echoed in the plan.
    const env = Object.fromEntries(plan.env);
    const bridge = JSON.parse(env.KEEPDECK_BRIDGE);
    // The pane's OWN directory, not the run root: the deck's doorbell is
    // addressed by pane, so a knock meant for another reaches nobody.
    //
    // The version is the CONSTANT, never a literal. Written as `1` here, this
    // assertion did not witness the field — it agreed with a stale value and
    // held it in place while the deck moved on. What ties the constant to the
    // deck's own number, and to every reporter's envelopes, is the pin in
    // scripts/reporterScripts.test.mjs; this checks only that what the app
    // speaks is what it arms panes with.
    expect(bridge).toMatchObject({
      v: BRIDGE_PROTOCOL_VERSION,
      dir: "/bridge/run-1/pane-1",
      pane: "pane-1",
      // The address is the only lane a reporter has; the directory beside it
      // carries the doorbell, which runs the other way.
      url: "http://127.0.0.1:51611/envelope",
    });
    expect(plan.token).toBe(bridge.token);
  });

  it("arms nothing at all when the bridge has no surface", async () => {
    // The address is the only lane a reporter has since the cutoff, so a
    // pane armed without one would spend its whole life reporting into
    // nowhere and looking alive doing it. No var at all is what says so:
    // a reporter finds nothing and stays inert.
    h.register(adopting);
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]), {
      ...ctx,
      bridgeUrl: "",
    });
    await settle();

    const env = Object.fromEntries(h.seen["pane-1"].env);
    expect(env).not.toHaveProperty("KEEPDECK_BRIDGE");
  });

  it("a pane's YOLO mode reaches the hook input on spawn AND resume", async () => {
    const inputs: Array<boolean | undefined> = [];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          inputs.push(input.yolo);
        },
        "resume.plan": (input) => {
          inputs.push(input.yolo);
        },
      },
    });
    await h.mount(
      ws([
        { id: "pane-1", agentType: "claude", yolo: true },
        { id: "pane-2", agentType: "claude" },
      ]),
    );
    await settle();
    await buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-9", workspace: W1, cwd: "/repo", yolo: true },
      ctx,
      "old-id",
      "restore",
    );
    // Armed pane spawns with it, plain pane WITHOUT it (absent, not false —
    // the wire shapes stay sparse), and a resume carries it the same way.
    expect(inputs.sort()).toEqual([true, true, undefined]);
  });

  it("threads a pane's remoteEndpoint to the hook as a nativeServer target", async () => {
    const targets: Array<unknown> = [];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          targets.push(input.target);
        },
      },
    });
    await h.mount(
      ws([
        {
          id: "pane-1",
          agentType: "claude",
          location: { kind: "remote", endpoint: "ws://vps:4500" },
        },
      ]),
    );
    await settle();
    expect(targets).toEqual([
      { kind: "nativeServer", endpoint: "ws://vps:4500" },
    ]);
  });

  it("omits target when the pane has no remoteEndpoint (local pane)", async () => {
    const targets: Array<unknown> = [];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          targets.push(input.target);
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(targets).toEqual([undefined]);
  });

  it("staged skills reach the hook input on spawn AND resume", async () => {
    skillsState.views = {
      claudePluginDir: "/home/skills/staging/ws-1/claude-plugin",
      opencodeConfigDir: "/home/skills/staging/ws-1/opencode",
      skillsDir: "/home/skills/staging/ws-1/skills",
    };
    const inputs: Array<SpawnSkillsInput | undefined> = [];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          inputs.push(input.skills);
        },
        "resume.plan": (input) => {
          inputs.push(input.skills);
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    await buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-9", workspace: W1, cwd: "/repo", stagedSkills, mcpAccess },
      ctx,
      "old-id",
      "restore",
    );
    expect(inputs).toEqual([skillsState.views, skillsState.views]);
  });

  it("an empty library leaves the hook input sparse — no skills key at all", async () => {
    const sawKey: boolean[] = [];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          sawKey.push("skills" in input);
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(sawKey).toEqual([false]);
  });

  it("builds each pane ONCE — a re-render must not re-mint", async () => {
    h.register(adopting);
    const workspaces = ws([{ id: "pane-1", agentType: "claude" }]);
    await h.mount(workspaces);
    await settle();
    const first = h.seen["pane-1"];

    await h.mount([...workspaces]); // new array identity → effect re-runs
    await settle();
    expect(h.seen["pane-1"]).toBe(first);
  });

  it("skips idle, provisioning and unknown-agent panes", async () => {
    h.register(adopting);
    await h.mount(
      ws([
        {
          id: "pane-d",
          agentType: "claude",
          idle: { reason: "waking", origin: "restore" },
        },
        { id: "pane-p", agentType: "claude", team: { teamId: "team-p", role: "lead" } },
        { id: "pane-u", agentType: "gemini" },
      ], [
        {
          id: "team-p",
          name: "making",
          location: { kind: "provisioning", intent: { repo: "/r", path: "/b/w-1", index: 1 } },
        },
      ]),
    );
    await settle();
    expect(h.seen).toEqual({});
  });

  it("a throwing hook degrades to a bare spawn, not a dead pane", async () => {
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          throw new Error("boom");
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();

    // Bare, but not anonymous: a kimi pane's config is planted before a hook
    // can throw and names this secret, so dropping it would lose the pane's
    // identity rather than degrade its spawn.
    expect(h.seen["pane-1"]).toEqual({
      command: "claude",
      args: [],
      env: [],
      mcpToken: expect.any(String),
    });
  });

  it("a throwing REMOTE spawn.plan does NOT degrade to a bare local spawn", async () => {
    // A bare spawn for a remote pane would run the agent LOCALLY, silently
    // dropping the endpoint — a wrong-target execution. The error must surface
    // instead (no plan lands), unlike the local degradation above.
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          throw new Error("boom");
        },
      },
    });
    await h.mount(
      ws([
        {
          id: "pane-1",
          agentType: "claude",
          location: { kind: "remote", endpoint: "ws://vps:4500" },
        },
      ]),
    );
    await settle();

    expect(h.seen["pane-1"]).toBeUndefined();
    // The failure is recorded so the deck can show an error tile (with a
    // retry) instead of hanging on "Waking up…" forever.
    expect(peekPanePlanError("pane-1")).toBe(true);
    clearPanePlanError("pane-1");
    expect(peekPanePlanError("pane-1")).toBe(false);
  });

  it("reports a failed build as a CHANGE, so the error tile can replace the spinner", async () => {
    // The failure has to count as a cache change: its consumer decides
    // between the error tile and "Waking up…" from what the cache says, and a
    // build that failed silently would leave the pane on the spinner until
    // some unrelated event happened along.
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          throw new Error("boom");
        },
      },
    });
    const workspaces = ws([
      { id: "pane-1", agentType: "claude", location: { kind: "remote", endpoint: "ws://vps:4500" } },
    ]);
    const changed = await buildLivePaneSpec(
      runtime.plugins,
      workspaces[0],
      workspaces[0].panes[0],
      ctx,
      { stagedSkills, mcpAccess },
    );

    // A failure is a CHANGE, and saying so is what gets the error tile drawn:
    // reported as "nothing happened", the pane would sit on "Waking up…" until
    // something unrelated redrew the deck.
    expect(changed).toBe(true);
    expect(peekPanePlanError("pane-1")).toBe(true);
  });

  it("an EXTERNAL plugin's off-capability command is clamped to its binary", async () => {
    // The hook picked a program its manifest never declared — a sandboxed
    // plugin must not choose the spawn target. Built-ins only warn.
    hostState.installed = [
      {
        manifest: {
          id: "test-plugin",
          capabilities: [{ kind: "exec", commands: ["claude"] }],
        },
        source: "external",
        status: { kind: "active" },
      },
    ];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (_input, output) => {
          output.command = "curl";
          output.args = ["evil.sh"];
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();

    expect(h.seen["pane-1"].command).toBe("claude"); // detect.bin, declared
    expect(h.seen["pane-1"].args).toEqual([]);
  });
});
