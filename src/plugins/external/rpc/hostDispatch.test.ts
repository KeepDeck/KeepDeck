import { describe, expect, it, vi } from "vitest";
import type {
  AgentContribution,
  FileOpenHandler,
  PluginContext,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import { createHostDispatch } from "./hostDispatch";
import type { WireHookCall } from "./protocol";

/**
 * The agent-hook proxy across the RPC seam: `agents.register` turns the
 * guest's declared hook NAMES into host-side proxies; invoking one pushes a
 * `hook:<id>` call into the realm and the correlated `agents.hookResult`
 * settles it — with the mutated output sanitized before it touches the
 * caller's object (the realm's word shapes a spawn).
 */
function harness() {
  let registered: AgentContribution | undefined;
  const pushes: { channel: string; payload: unknown }[] = [];
  const ctx = {
    agents: {
      register: vi.fn((agent: AgentContribution) => {
        registered = agent;
        return { dispose() {} };
      }),
    },
  } as unknown as PluginContext;
  const dispatch = createHostDispatch(ctx, (channel, payload) =>
    pushes.push({ channel, payload }),
  );
  return {
    dispatch,
    pushes,
    agent: () => {
      if (!registered) throw new Error("nothing registered");
      return registered;
    },
  };
}

const entry = {
  id: "gemini",
  label: "Gemini",
  detect: { bin: "gemini" },
  hookNames: ["spawn.plan", "definitely.not.a.hook"],
};

const output = (): SpawnPlanOutput => ({ command: "gemini", args: [], env: [] });

describe("agent hooks over the RPC seam", () => {
  it("proxies only the contract's hook names", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [1, entry]);
    expect(Object.keys(h.agent().hooks)).toEqual(["spawn.plan"]);
  });

  it("round-trips: push out, hookResult back, output mutated in place", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [1, entry]);

    const out = output();
    const running = h.agent().hooks["spawn.plan"]!(
      { paneId: "pane-1", wsId: "ws-1", cwd: "/repo" },
      out,
    );
    expect(h.pushes).toHaveLength(1);
    const { channel, payload } = h.pushes[0];
    expect(channel).toMatch(/^hook:\d+$/);
    expect((payload as WireHookCall).agentId).toBe("gemini");

    const id = Number(channel.slice("hook:".length));
    await h.dispatch.call("agents.hookResult", [
      id,
      { ok: true, output: { command: "gemini", args: ["--fast"], env: [["A", "1"]] } },
    ]);
    await running;
    expect(out.args).toEqual(["--fast"]);
    expect(out.env).toEqual([["A", "1"]]);
  });

  it("a malformed realm output rejects instead of reaching the spawn", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [1, entry]);
    const running = h.agent().hooks["spawn.plan"]!(
      { paneId: "pane-1", wsId: "ws-1", cwd: "/repo" },
      output(),
    );
    const id = Number(h.pushes[0].channel.slice("hook:".length));
    await h.dispatch.call("agents.hookResult", [
      id,
      // args smuggling a non-string — must never reach argv.
      { ok: true, output: { command: "gemini", args: [{ evil: true }], env: [] } },
    ]);
    await expect(running).rejects.toThrow("malformed");
  });

  it("dispose fails hooks still in flight", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [1, entry]);
    const running = h.agent().hooks["spawn.plan"]!(
      { paneId: "pane-1", wsId: "ws-1", cwd: "/repo" },
      output(),
    );
    h.dispatch.dispose();
    await expect(running).rejects.toThrow("disposed");
  });
});

/** Harness over the file-open surface: `openers.register` proxies the realm's
 * handler; `ui.revealDockTab` forwards straight through. */
function openersHarness() {
  let registered: FileOpenHandler | undefined;
  const revealed: string[] = [];
  const pushes: { channel: string; payload: unknown }[] = [];
  const ctx = {
    openers: {
      register: vi.fn((handler: FileOpenHandler) => {
        registered = handler;
        return { dispose() {} };
      }),
    },
    ui: { revealDockTab: (id: string) => revealed.push(id) },
  } as unknown as PluginContext;
  const dispatch = createHostDispatch(ctx, (channel, payload) =>
    pushes.push({ channel, payload }),
  );
  return {
    dispatch,
    pushes,
    revealed,
    handler: () => {
      if (!registered) throw new Error("nothing registered");
      return registered;
    },
  };
}

describe("file-open handlers over the RPC seam", () => {
  it("round-trips: push out, openResult back, boolean sanitized", async () => {
    const h = openersHarness();
    await h.dispatch.call("openers.register", [1, { id: "peek", label: "Peek" }]);
    expect(h.handler().id).toBe("peek");

    const asking = h.handler().open({ path: "/repo/readme.md" });
    expect(h.pushes[0].channel).toMatch(/^open:/);
    expect(h.pushes[0].payload).toEqual({
      handlerId: "peek",
      request: { path: "/repo/readme.md" },
    });
    const id = Number(h.pushes[0].channel.slice("open:".length));
    await h.dispatch.call("openers.openResult", [id, { ok: true, handled: true }]);
    await expect(asking).resolves.toBe(true);

    // A hostile realm's word only gets to be a boolean: truthy junk = decline.
    const lying = h.handler().open({ path: "/repo/x" });
    const id2 = Number(h.pushes[1].channel.slice("open:".length));
    await h.dispatch.call("openers.openResult", [id2, { ok: true, handled: "yes" }]);
    await expect(lying).resolves.toBe(false);
  });

  it("a hung realm times out into a rejection — the click's chain moves on", async () => {
    vi.useFakeTimers();
    try {
      const h = openersHarness();
      await h.dispatch.call("openers.register", [1, { id: "peek", label: "Peek" }]);
      const asking = h.handler().open({ path: "/repo/x" });
      const failed = expect(asking).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a malformed openResult settles as a failure — it must NEVER strand the click", async () => {
    // The settle runs after clearTimeout: junk throwing there would leave the
    // promise pending forever, past the very timeout meant to prevent hangs.
    for (const junk of [undefined, null, 42, {}, { ok: "yes" }]) {
      const h = openersHarness();
      await h.dispatch.call("openers.register", [1, { id: "peek", label: "Peek" }]);
      const asking = h.handler().open({ path: "/repo/x" });
      const id = Number(h.pushes[0].channel.slice("open:".length));
      await h.dispatch.call("openers.openResult", [id, junk]);
      await expect(asking).rejects.toThrow(/malformed|failure/);
    }
  });

  it("a malformed hookResult settles as a failure too — same stranding shape", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [1, entry]);
    const running = h.agent().hooks["spawn.plan"]!(
      { paneId: "pane-1", wsId: "ws-1", cwd: "/repo" },
      output(),
    );
    const id = Number(h.pushes[0].channel.slice("hook:".length));
    await h.dispatch.call("agents.hookResult", [id]); // no result arg at all
    await expect(running).rejects.toThrow("malformed");
  });

  it("dispose fails opens still in flight; a late openResult is ignored", async () => {
    const h = openersHarness();
    await h.dispatch.call("openers.register", [1, { id: "peek", label: "Peek" }]);
    const asking = h.handler().open({ path: "/repo/x" });
    h.dispatch.dispose();
    await expect(asking).rejects.toThrow("disposed");
    const id = Number(h.pushes[0].channel.slice("open:".length));
    // Settled already — the straggler must be a no-op, not a crash.
    await h.dispatch.call("openers.openResult", [id, { ok: true, handled: true }]);
  });

  it("ui.revealDockTab forwards the id verbatim", async () => {
    const h = openersHarness();
    await h.dispatch.call("ui.revealDockTab", ["files"]);
    expect(h.revealed).toEqual(["files"]);
  });
});
