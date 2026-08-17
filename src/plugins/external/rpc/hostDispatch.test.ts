import { describe, expect, it, vi } from "vitest";
import type {
  AgentContribution,
  FileOpenHandler,
  PluginContext,
  SpawnPlanOutput,
  WorkspaceRef,
} from "@keepdeck/plugin-api";
import { createHostDispatch } from "./hostDispatch";
import type { WireAgentHistoryCall, WireHookCall } from "./protocol";

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

describe("workspace storage over the RPC seam", () => {
  const ref: WorkspaceRef = { id: "ws-1", instance: "instance-1" };

  it("forwards the exact workspace lifetime on every operation", async () => {
    const kv = {
      get: vi.fn(async () => "value"),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const workspace = vi.fn(() => kv);
    const dispatch = createHostDispatch(
      { storage: { workspace } } as unknown as PluginContext,
      () => {},
    );

    await expect(
      dispatch.call("storage.workspace.get", [ref, "key"]),
    ).resolves.toBe("value");
    await dispatch.call("storage.workspace.set", [ref, "key", 42]);
    await dispatch.call("storage.workspace.delete", [ref, "key"]);

    expect(workspace).toHaveBeenCalledTimes(3);
    expect(workspace).toHaveBeenNthCalledWith(1, ref);
    expect(workspace).toHaveBeenNthCalledWith(2, ref);
    expect(workspace).toHaveBeenNthCalledWith(3, ref);
    expect(kv.set).toHaveBeenCalledWith("key", 42);
    expect(kv.delete).toHaveBeenCalledWith("key");
  });

  it("rejects the pre-API-21 wsId-only shape", async () => {
    const workspace = vi.fn();
    const dispatch = createHostDispatch(
      { storage: { workspace } } as unknown as PluginContext,
      () => {},
    );

    await expect(
      dispatch.call("storage.workspace.get", ["ws-1", "key"]),
    ).rejects.toThrow(/lifetime ref/);
    expect(workspace).not.toHaveBeenCalled();
  });
});

describe("agent hooks over the RPC seam", () => {
  it("proxies only the contract's hook names", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [1, entry]);
    expect(Object.keys(h.agent().hooks)).toEqual(["spawn.plan"]);
  });

  it("carries fork.plan as a first-class hook", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [
      1,
      { ...entry, hookNames: ["fork.plan"] },
    ]);
    expect(Object.keys(h.agent().hooks)).toEqual(["fork.plan"]);
  });

  it("supportsYolo crosses strictly; a non-true value from the realm drops", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [1, { ...entry, supportsYolo: true }]);
    expect(h.agent().supportsYolo).toBe(true);

    await h.dispatch.call("agents.register", [2, { ...entry, supportsYolo: "yes" }]);
    expect(h.agent().supportsYolo).toBeUndefined();
  });

  it("an icon crosses in the contract's exact shape, extras stripped", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [
      1,
      {
        ...entry,
        icon: {
          viewBox: "0 0 24 24",
          paths: [
            {
              d: "M0 0h24v24H0z",
              color: "#D97757",
              fillRule: "evenodd",
              onload: "alert(1)",
            },
          ],
          onload: "alert(1)",
        },
      },
    ]);
    expect(h.agent().icon).toEqual({
      viewBox: "0 0 24 24",
      paths: [{ d: "M0 0h24v24H0z", color: "#D97757", fillRule: "evenodd" }],
    });
  });

  it("an icon with no valid layer drops without refusing the registration", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [
      1,
      { ...entry, icon: { viewBox: "0 0 24 24", paths: [{ d: 42 }, "junk"] } },
    ]);
    expect(h.agent().icon).toBeUndefined();
    expect(h.agent().id).toBe("gemini");
  });

  it("off-shape layers and attributes drop, the valid layers stay", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [
      1,
      {
        ...entry,
        icon: {
          viewBox: "0 0 24 24",
          paths: [
            { d: "M0 0h24v24H0z", color: 0xd97757, fillRule: "inherit" },
            { d: 42 },
            { d: "M2 2h20v20H2z", color: "#F1ECEC" },
          ],
        },
      },
    ]);
    expect(h.agent().icon).toEqual({
      viewBox: "0 0 24 24",
      paths: [{ d: "M0 0h24v24H0z" }, { d: "M2 2h20v20H2z", color: "#F1ECEC" }],
    });
  });

  it("round-trips: push out, hookResult back, output mutated in place", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [1, entry]);

    const out = output();
    const running = h.agent().hooks["spawn.plan"]!(
      {
        paneId: "pane-1",
        workspace: { id: "ws-1", instance: "workspace-instance-1" },
        cwd: "/repo",
      },
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
      {
        paneId: "pane-1",
        workspace: { id: "ws-1", instance: "workspace-instance-1" },
        cwd: "/repo",
      },
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
      {
        paneId: "pane-1",
        workspace: { id: "ws-1", instance: "workspace-instance-1" },
        cwd: "/repo",
      },
      output(),
    );
    h.dispatch.dispose();
    await expect(running).rejects.toThrow("disposed");
  });
});

describe("agent history over the RPC seam", () => {
  it("round-trips every history method and sanitizes returned data", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [1, { ...entry, hasHistory: true }]);
    const history = h.agent().history!;

    const list = history.list();
    expect(h.pushes[0].payload).toEqual({
      agentId: "gemini",
      method: "list",
      args: [],
    } satisfies WireAgentHistoryCall);
    await h.dispatch.call("agents.historyResult", [
      Number(h.pushes[0].channel.slice("history:".length)),
      {
        ok: true,
        value: [
          {
            sessionId: "session-1",
            ref: "/store/session-1",
            mtime: 42,
            size: 7,
            ignored: "host strips extras",
          },
        ],
      },
    ]);
    await expect(list).resolves.toEqual([
      {
        sessionId: "session-1",
        ref: "/store/session-1",
        mtime: 42,
        size: 7,
      },
    ]);

    const describe = history.describe("/store/session-1");
    await h.dispatch.call("agents.historyResult", [
      Number(h.pushes[1].channel.slice("history:".length)),
      {
        ok: true,
        value: {
          cwd: "/repo",
          title: "Session",
          transcriptPath: "/transcript",
        },
      },
    ]);
    await expect(describe).resolves.toEqual({
      cwd: "/repo",
      title: "Session",
      transcriptPath: "/transcript",
    });

    const content = history.content("/store/session-1");
    await h.dispatch.call("agents.historyResult", [
      Number(h.pushes[2].channel.slice("history:".length)),
      { ok: true, value: "searchable text" },
    ]);
    await expect(content).resolves.toBe("searchable text");

    const transcript = history.transcript("/store/session-1", {
      offset: 0,
      limit: 20,
    });
    await h.dispatch.call("agents.historyResult", [
      Number(h.pushes[3].channel.slice("history:".length)),
      { ok: true, value: [{ role: "assistant", text: "Hello", ignored: true }] },
    ]);
    await expect(transcript).resolves.toEqual([
      { role: "assistant", text: "Hello" },
    ]);
  });

  it("rejects malformed history data and fails reads still in flight on dispose", async () => {
    const malformed = harness();
    await malformed.dispatch.call("agents.register", [
      1,
      { ...entry, hasHistory: true },
    ]);
    const listing = malformed.agent().history!.list();
    await malformed.dispatch.call("agents.historyResult", [
      Number(malformed.pushes[0].channel.slice("history:".length)),
      { ok: true, value: [{ sessionId: "session-1" }] },
    ]);
    await expect(listing).rejects.toThrow("malformed");

    // An unknown extra field in facts drops at the boundary — the answer
    // is rebuilt from known fields only, never passed through.
    const junkField = harness();
    await junkField.dispatch.call("agents.register", [
      1,
      { ...entry, hasHistory: true },
    ]);
    const describing = junkField.agent().history!.describe("/store/s");
    await junkField.dispatch.call("agents.historyResult", [
      Number(junkField.pushes[0].channel.slice("history:".length)),
      { ok: true, value: { cwd: "/repo", forkedAt: "yes" } },
    ]);
    await expect(describing).resolves.toEqual({ cwd: "/repo" });

    const disposed = harness();
    await disposed.dispatch.call("agents.register", [
      1,
      { ...entry, hasHistory: true },
    ]);
    const content = disposed.agent().history!.content("/store/session-1");
    disposed.dispatch.dispose();
    await expect(content).rejects.toThrow("disposed");
  });

  it("listing is proxied only under the guest's hasListing declaration", async () => {
    // No declaration → no method: the host must never ask a realm for a
    // method it never claimed — old guests throw on the unknown name, which
    // is this contract's own freeze, reborn for the whole external tier.
    const silent = harness();
    await silent.dispatch.call("agents.register", [
      1,
      { ...entry, hasHistory: true },
    ]);
    expect(silent.agent().history!.listing).toBeUndefined();

    const declared = harness();
    await declared.dispatch.call("agents.register", [
      1,
      { ...entry, hasHistory: true, hasListing: true },
    ]);
    const asking = declared.agent().history!.listing!();
    expect(declared.pushes[0].payload).toEqual({
      agentId: "gemini",
      method: "listing",
      args: [],
    } satisfies WireAgentHistoryCall);
    await declared.dispatch.call("agents.historyResult", [
      Number(declared.pushes[0].channel.slice("history:".length)),
      {
        ok: true,
        value: {
          stubs: [
            { sessionId: "session-1", ref: "/store/session-1", mtime: 42, size: 7 },
          ],
          complete: false,
        },
      },
    ]);
    await expect(asking).resolves.toEqual({
      stubs: [
        { sessionId: "session-1", ref: "/store/session-1", mtime: 42, size: 7 },
      ],
      complete: false,
    });
  });

  it("a listing answer with a non-boolean complete fails the boundary", async () => {
    // The realm's word may never turn junk into a prune permit: anything
    // but a literal boolean complete rejects as malformed.
    const h = harness();
    await h.dispatch.call("agents.register", [
      1,
      { ...entry, hasHistory: true, hasListing: true },
    ]);
    const asking = h.agent().history!.listing!();
    await h.dispatch.call("agents.historyResult", [
      Number(h.pushes[0].channel.slice("history:".length)),
      { ok: true, value: { stubs: [], complete: "yes" } },
    ]);
    await expect(asking).rejects.toThrow("malformed");
  });

  it("liveSessions is proxied only under the guest's hasLiveSessions declaration", async () => {
    // No declaration → no capability at all: the host must never ask a
    // realm for a call it never claimed — the same refusal freeze the
    // listing negotiation prevents, on its own channel.
    const silent = harness();
    await silent.dispatch.call("agents.register", [1, entry]);
    expect(silent.agent().liveSessions).toBeUndefined();

    const declared = harness();
    await declared.dispatch.call("agents.register", [
      1,
      { ...entry, hasLiveSessions: true },
    ]);
    const asking = declared.agent().liveSessions!.list();
    expect(declared.pushes[0].channel).toMatch(/^livesessions:\d+$/);
    expect(declared.pushes[0].payload).toEqual({ agentId: "gemini" });
    await declared.dispatch.call("agents.liveResult", [
      Number(declared.pushes[0].channel.slice("livesessions:".length)),
      {
        ok: true,
        value: [
          {
            sessionId: "session-1",
            kind: "background",
            name: "Fix the build",
            state: "working",
            pid: 42,
          },
        ],
      },
    ]);
    await expect(asking).resolves.toEqual([
      { sessionId: "session-1", kind: "background", name: "Fix the build", state: "working" },
    ]);
  });

  it("a live-sessions answer with junk rows fails the whole boundary", async () => {
    const h = harness();
    await h.dispatch.call("agents.register", [
      1,
      { ...entry, hasLiveSessions: true },
    ]);
    const asking = h.agent().liveSessions!.list();
    await h.dispatch.call("agents.liveResult", [
      Number(h.pushes[0].channel.slice("livesessions:".length)),
      { ok: true, value: [{ sessionId: 7, kind: "background" }] },
    ]);
    await expect(asking).rejects.toThrow("malformed");
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
      {
        paneId: "pane-1",
        workspace: { id: "ws-1", instance: "workspace-instance-1" },
        cwd: "/repo",
      },
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

  it("notify passes the wire value through to ctx.notify untouched", async () => {
    const notified: unknown[] = [];
    const ctx = {
      notify: (input: unknown) => notified.push(input),
    } as unknown as PluginContext;
    const dispatch = createHostDispatch(ctx, () => {});
    // Raw junk stays raw — the port behind ctx.notify owns ALL validation, so
    // the dispatch layer must not shape (or reject) the value.
    await dispatch.call("notify", [{ title: "hi", junk: 1 }]);
    expect(notified).toEqual([{ title: "hi", junk: 1 }]);
    dispatch.dispose();
  });
});

describe("sessions over the RPC seam", () => {
  it("a PTY landing after dispose is closed, not stored", async () => {
    const close = vi.fn(async () => {});
    let releaseSpawn!: () => void;
    const spawn = vi.fn(
      () =>
        new Promise<{ id: string; write: () => void; resize: () => void; close: typeof close }>(
          (resolve) => {
            releaseSpawn = () =>
              resolve({ id: "s-1", write: vi.fn(), resize: vi.fn(), close });
          },
        ),
    );
    const ctx = {
      services: { sessions: { spawn } },
    } as unknown as PluginContext;
    const dispatch = createHostDispatch(ctx, () => {});

    const starting = dispatch.call("services.sessions.spawn", [{ command: "x" }]);
    // The realm dies while the PTY is spawning: the sweep already ran over a
    // map the handle isn't in yet. Storing it would orphan a live process
    // group — the exact leak the speech guard closed one handler over.
    dispatch.dispose();
    releaseSpawn();
    await expect(starting).rejects.toThrow("disposed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("speech captures over the RPC seam", () => {
  function speechHarness() {
    const cancel = vi.fn(async () => {});
    const stop = vi.fn(async () => ({ text: "", silence: true, seconds: 0, level: 0 }));
    let releaseStart!: () => void;
    const startCapture = vi.fn(
      () =>
        new Promise<{ stop: typeof stop; cancel: typeof cancel }>((resolve) => {
          releaseStart = () => resolve({ stop, cancel });
        }),
    );
    const ctx = {
      services: { speech: { startCapture } },
    } as unknown as PluginContext;
    const dispatch = createHostDispatch(ctx, () => {});
    return { dispatch, cancel, stop, releaseStart: () => releaseStart() };
  }

  it("a capture landing after dispose is cancelled, not stored", async () => {
    const h = speechHarness();
    const starting = h.dispatch.call("services.speech.start", [1]);
    // The realm dies while the device is opening: the dispose sweep runs over
    // a map this capture isn't in yet. The app holds ONE capture slot
    // process-wide, so storing it here would park a live microphone where
    // nothing can ever cancel it.
    h.dispatch.dispose();
    h.releaseStart();
    await expect(starting).rejects.toThrow("disposed");
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("a throwing registration disposer cannot strand the rest of the sweep", async () => {
    const cancel = vi.fn(async () => {});
    const goodDispose = vi.fn();
    const warns: string[] = [];
    const ctx = {
      log: { warn: (m: string) => warns.push(m), info: vi.fn(), error: vi.fn() },
      services: {
        speech: {
          startCapture: vi.fn(async () => ({
            stop: vi.fn(),
            cancel,
          })),
        },
      },
      settings: {
        registerSection: vi
          .fn()
          .mockReturnValueOnce({
            dispose: () => {
              throw new Error("broken brace");
            },
          })
          .mockReturnValueOnce({ dispose: goodDispose }),
      },
    } as unknown as PluginContext;
    const dispatch = createHostDispatch(ctx, () => {});

    await dispatch.call("services.speech.start", [1]);
    await dispatch.call("settings.registerSection", [1, { label: "a", fields: [] }]);
    await dispatch.call("settings.registerSection", [2, { label: "b", fields: [] }]);

    // The first registration's disposer throws. The sweep must reach the
    // second one anyway — and the mic, the scarcest resource here, is
    // cancelled before any third-party brace gets a chance to throw.
    dispatch.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(goodDispose).toHaveBeenCalledTimes(1);
    expect(warns.some((w) => w.includes("broken brace"))).toBe(true);
  });

  it("a capture landing before dispose is stored, and dispose cancels it", async () => {
    const h = speechHarness();
    const starting = h.dispatch.call("services.speech.start", [1]);
    h.releaseStart();
    await starting;
    expect(h.cancel).not.toHaveBeenCalled();
    h.dispatch.dispose();
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });
});
