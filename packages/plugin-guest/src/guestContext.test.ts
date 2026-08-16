import { describe, expect, it, vi } from "vitest";
import { buildGuestContext } from "./context";
import { fakeManifest } from "./fakeHost";
import { GuestRpc } from "./rpc";
import type { DownloadRequest } from "@keepdeck/plugin-api";

/**
 * Direct tests of the guest context builder — the parts worth pinning without
 * standing up the whole channel. Chief among them: an external dock tab MUST be
 * the iframe variant, and the guest must reject a Component synchronously (a
 * plugin author sees the mistake at the `register` call, not as a silent no-op
 * or a broken frame later).
 */

/** A GuestRpc over a port whose `postMessage` is a no-op — the synchronous
 * guard under test fires before anything would be sent. */
function silentRpc(): GuestRpc {
  const port = { postMessage() {}, onmessage: null } as unknown as MessagePort;
  return new GuestRpc(port);
}

describe("buildGuestContext dock tabs", () => {
  it("throws synchronously when a dock tab carries a React Component", () => {
    const { ctx } = buildGuestContext(silentRpc(), fakeManifest());
    expect(() =>
      ctx.ui.registerDockTab({ id: "t", label: "T", Component: () => null }),
    ).toThrow(/iframe/);
  });

  it("accepts the iframe dock-tab variant", () => {
    const { ctx } = buildGuestContext(silentRpc(), fakeManifest());
    const disposable = ctx.ui.registerDockTab({
      id: "t",
      label: "T",
      iframe: "ui/panel.html",
    });
    expect(typeof disposable.dispose).toBe("function");
  });

  it("carries the host-provided manifest through as ctx.manifest", () => {
    const manifest = fakeManifest("dev.custom");
    const { ctx } = buildGuestContext(silentRpc(), manifest);
    expect(ctx.manifest).toBe(manifest);
  });
});

describe("registration outcomes fail loud", () => {
  it("a refused registration rejects registrationsSettled", async () => {
    // The host answers ok:false (an undeclared contribution, a gate
    // violation) — activation must FAIL, not show active with the
    // contribution silently missing.
    const rpc = {
      call: vi.fn((path: string) =>
        path === "agents.register"
          ? Promise.reject(new Error('agents "codex" not declared'))
          : Promise.resolve(undefined),
      ),
    } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      detect: { bin: "codex" },
      hooks: {},
    });
    await expect(bundle.registrationsSettled()).rejects.toThrow("not declared");
  });

  it("accepted registrations settle clean", async () => {
    const rpc = {
      call: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    bundle.ctx.settings.registerSection({ label: "S", fields: [] });
    await expect(bundle.registrationsSettled()).resolves.toBeUndefined();
  });

  /** Activation is long over by the time the documented register-while-on /
   * dispose-when-off pattern fires, so a refusal there has no activation left
   * to fail — and nothing awaiting it. It must be reported rather than left as
   * a bare rejection in the realm, and it must not be retained: one settled
   * promise per user toggle, kept for the life of the realm, is the leak. */
  it("reports a post-activation refusal instead of retaining it", async () => {
    const call = vi.fn((path: string, ..._args: unknown[]) =>
      path === "settings.registerSection"
        ? Promise.reject(new Error("settings not declared"))
        : Promise.resolve(undefined),
    );
    const rpc = { call } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    await bundle.registrationsSettled();

    bundle.ctx.settings.registerSection({ label: "S", fields: [] });

    const warned = () => call.mock.calls.find(([path]) => path === "log.warn");
    await vi.waitFor(() => expect(warned()).toBeDefined());
    const [message] = warned()![1] as string[];
    expect(message).toContain("settings not declared");
    // Retained, that refusal would resurface here — and, unhandled, would
    // reach the realm as an unhandled rejection.
    await expect(bundle.registrationsSettled()).resolves.toBeUndefined();
  });
});

describe("agent registration payload", () => {
  it("carries the icon as data; hooks cross as names only", async () => {
    const call = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
    const rpc = { call } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    const icon = {
      viewBox: "0 0 24 24",
      paths: [{ d: "M0 0h24v24H0z", color: "#D97757" }],
    };
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      icon,
      detect: { bin: "codex" },
      hooks: { "spawn.plan": () => {} },
    });
    await bundle.registrationsSettled();
    const register = call.mock.calls.find(
      ([path]) => path === "agents.register",
    );
    expect(register).toBeDefined();
    const [, payload] = register![1] as [number, Record<string, unknown>];
    expect(payload.icon).toEqual(icon);
    expect(payload.hookNames).toEqual(["spawn.plan"]);
    expect(payload).not.toHaveProperty("hooks");
    // Not declared → not on the wire (sparse, like the host's strict read).
    expect(payload).not.toHaveProperty("supportsYolo");
  });

  it("warns loudly when an agent declares usage — the tier cannot carry it", async () => {
    const call = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
    const rpc = { call } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      detect: { bin: "codex" },
      hooks: {},
      usage: { capabilities: ["paneTelemetry"], normalize: () => null },
    });
    await bundle.registrationsSettled();
    const warn = call.mock.calls.find(([path]) => path === "log.warn");
    expect(warn).toBeDefined();
    expect(String((warn![1] as string[])[0])).toContain("usage contributions");
    // And the declaration still never rides the wire (functions can't).
    const register = call.mock.calls.find(([path]) => path === "agents.register");
    const [, payload] = register![1] as [number, Record<string, unknown>];
    expect(payload).not.toHaveProperty("usage");
  });

  it("warns loudly when an agent declares status — the tier cannot carry it", async () => {
    const call = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
    const rpc = { call } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      detect: { bin: "codex" },
      hooks: {},
      status: { normalize: () => null },
    });
    await bundle.registrationsSettled();
    const warn = call.mock.calls.find(([path]) => path === "log.warn");
    expect(warn).toBeDefined();
    expect(String((warn![1] as string[])[0])).toContain("status contributions");
    // And the declaration still never rides the wire (functions can't).
    const register = call.mock.calls.find(([path]) => path === "agents.register");
    const [, payload] = register![1] as [number, Record<string, unknown>];
    expect(payload).not.toHaveProperty("status");
  });

  it("carries a declared supportsYolo onto the wire", async () => {
    const call = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
    const rpc = { call } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      detect: { bin: "codex" },
      supportsYolo: true,
      hooks: { "spawn.plan": () => {} },
    });
    await bundle.registrationsSettled();
    const register = call.mock.calls.find(
      ([path]) => path === "agents.register",
    );
    const [, payload] = register![1] as [number, Record<string, unknown>];
    expect(payload.supportsYolo).toBe(true);
  });

  it("keeps history callbacks local and serves host history requests", async () => {
    const call = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
    const rpc = { call } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    const describe = vi.fn(async (ref: string) => ({
      cwd: "/repo",
      title: ref,
    }));
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      detect: { bin: "codex" },
      hooks: {},
      history: {
        list: async () => [],
        describe,
        content: async () => "",
        transcript: async () => [],
      },
    });
    await bundle.registrationsSettled();

    const register = call.mock.calls.find(([path]) => path === "agents.register");
    const [, payload] = register![1] as [number, Record<string, unknown>];
    expect(payload.hasHistory).toBe(true);
    expect(payload).not.toHaveProperty("history");

    bundle.dispatchEvent("history:17", {
      agentId: "codex",
      method: "describe",
      args: ["session-ref"],
    });
    await vi.waitFor(() =>
      expect(
        call.mock.calls.find(
          ([path, args]) =>
            path === "agents.historyResult" &&
            (args as unknown[])[0] === 17,
        ),
      ).toBeDefined(),
    );
    expect(describe).toHaveBeenCalledWith("session-ref");
    const result = call.mock.calls.find(
      ([path, args]) =>
        path === "agents.historyResult" && (args as unknown[])[0] === 17,
    );
    expect((result![1] as unknown[])[1]).toEqual({
      ok: true,
      value: { cwd: "/repo", title: "session-ref" },
    });
  });

  it("declares hasListing iff the history object really has the method, and serves listing requests", async () => {
    // The wire flag is the host's ONLY basis for exposing `listing` in its
    // proxy — a false declaration gets an old-guest realm asked for a
    // method it throws on, so the flag tracks the object, not optimism.
    const call = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
    const rpc = { call } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    const listing = vi.fn(async () => ({ stubs: [], complete: false }));
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      detect: { bin: "codex" },
      hooks: {},
      history: {
        list: async () => [],
        describe: async () => ({ cwd: "/repo" }),
        content: async () => "",
        transcript: async () => [],
        listing,
      },
    });
    bundle.ctx.agents.register({
      id: "old",
      label: "Old Guest",
      detect: { bin: "old" },
      hooks: {},
      history: {
        list: async () => [],
        describe: async () => ({ cwd: "/repo" }),
        content: async () => "",
        transcript: async () => [],
      },
    });
    await bundle.registrationsSettled();

    const payloads = call.mock.calls
      .filter(([path]) => path === "agents.register")
      .map(([, payload]) => (payload as [number, Record<string, unknown>])[1]);
    expect(payloads[0].hasListing).toBe(true);
    expect(payloads[1]).not.toHaveProperty("hasListing");

    bundle.dispatchEvent("history:17", {
      agentId: "codex",
      method: "listing",
      args: [],
    });
    await vi.waitFor(() =>
      expect(
        call.mock.calls.find(
          ([path, args]) =>
            path === "agents.historyResult" && (args as unknown[])[0] === 17,
        ),
      ).toBeDefined(),
    );
    expect(listing).toHaveBeenCalledTimes(1);
    const answered = call.mock.calls.find(
      ([path, args]) =>
        path === "agents.historyResult" && (args as unknown[])[0] === 17,
    );
    expect((answered![1] as unknown[])[1]).toEqual({
      ok: true,
      value: { stubs: [], complete: false },
    });

    // Asked despite no declaration (a lying host): a FAILURE reply, never a
    // crash — exactly the refusal the host's list() fallback listens for.
    bundle.dispatchEvent("history:18", {
      agentId: "old",
      method: "listing",
      args: [],
    });
    await vi.waitFor(() =>
      expect(
        call.mock.calls.find(
          ([path, args]) =>
            path === "agents.historyResult" && (args as unknown[])[0] === 18,
        ),
      ).toBeDefined(),
    );
    const refused = call.mock.calls.find(
      ([path, args]) =>
        path === "agents.historyResult" && (args as unknown[])[0] === 18,
    );
    expect(((refused![1] as unknown[])[1] as { ok: boolean }).ok).toBe(false);
  });

  it("declares hasLiveSessions iff the agent contributes one, and serves the query on its own channel", async () => {
    const call = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
    const rpc = { call } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    const list = vi.fn(async () => [
      { sessionId: "s-1", kind: "background", name: "Fix the build", state: "working" },
    ]);
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      detect: { bin: "codex" },
      hooks: {},
      liveSessions: { list },
    });
    bundle.ctx.agents.register({
      id: "old",
      label: "Old Guest",
      detect: { bin: "old" },
      hooks: {},
    });
    await bundle.registrationsSettled();

    const payloads = call.mock.calls
      .filter(([path]) => path === "agents.register")
      .map(([, payload]) => (payload as [number, Record<string, unknown>])[1]);
    expect(payloads[0].hasLiveSessions).toBe(true);
    expect(payloads[1]).not.toHaveProperty("hasLiveSessions");

    bundle.dispatchEvent("livesessions:23", { agentId: "codex" });
    await vi.waitFor(() =>
      expect(
        call.mock.calls.find(
          ([path, args]) =>
            path === "agents.liveResult" && (args as unknown[])[0] === 23,
        ),
      ).toBeDefined(),
    );
    expect(list).toHaveBeenCalledTimes(1);
    const answered = call.mock.calls.find(
      ([path, args]) =>
        path === "agents.liveResult" && (args as unknown[])[0] === 23,
    );
    expect((answered![1] as unknown[])[1]).toEqual({
      ok: true,
      value: [
        { sessionId: "s-1", kind: "background", name: "Fix the build", state: "working" },
      ],
    });

    // A query for an agent that never declared the capability answers with
    // a FAILURE — the honest refusal, not a crash and not an empty list.
    bundle.dispatchEvent("livesessions:24", { agentId: "old" });
    await vi.waitFor(() =>
      expect(
        call.mock.calls.find(
          ([path, args]) =>
            path === "agents.liveResult" && (args as unknown[])[0] === 24,
        ),
      ).toBeDefined(),
    );
    const refused = call.mock.calls.find(
      ([path, args]) =>
        path === "agents.liveResult" && (args as unknown[])[0] === 24,
    );
    expect(((refused![1] as unknown[])[1] as { ok: boolean }).ok).toBe(false);
  });
});

describe("remote download streams", () => {
  const request: DownloadRequest = {
    id: "download-1",
    source: { url: "https://example.com/file" },
    target: { kind: "file", path: "file" },
  };

  it("rejects duplicate ids without replacing the first route", async () => {
    const rpc = { call: vi.fn(async () => undefined) } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    const first = bundle.ctx.services.downloads.start(request);
    expect(() => bundle.ctx.services.downloads.start(request)).toThrow(
      "download id already used",
    );
    const iterator = first[Symbol.asyncIterator]();
    bundle.dispatchEvent("download:download-1", {
      id: "download-1",
      phase: "downloading",
      received: 5,
      total: 10,
    });
    expect((await iterator.next()).value?.received).toBe(5);
  });

  it("conflates progress and return detaches only that reader", async () => {
    const rpc = { call: vi.fn(async () => undefined) } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    const iterator = bundle.ctx.services.downloads
      .start(request)
      [Symbol.asyncIterator]();
    bundle.dispatchEvent("download:download-1", {
      id: "download-1",
      phase: "downloading",
      received: 1,
      total: 10,
    });
    bundle.dispatchEvent("download:download-1", {
      id: "download-1",
      phase: "downloading",
      received: 9,
      total: 10,
    });
    expect((await iterator.next()).value?.received).toBe(9);
    await iterator.return?.();
    bundle.dispatchEvent("download:download-1", {
      id: "download-1",
      phase: "completed",
      received: 10,
      total: 10,
    });
    expect((await iterator.next()).done).toBe(true);
  });

  it("fans the current state out to independent readers", async () => {
    const rpc = { call: vi.fn(async () => undefined) } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    const stream = bundle.ctx.services.downloads.start(request);
    const first = stream[Symbol.asyncIterator]();
    const second = stream[Symbol.asyncIterator]();

    bundle.dispatchEvent("download:download-1", {
      id: "download-1",
      phase: "downloading",
      received: 4,
      total: 10,
    });
    expect((await first.next()).value?.received).toBe(4);
    expect((await second.next()).value?.received).toBe(4);

    await first.return?.();
    bundle.dispatchEvent("download:download-1", {
      id: "download-1",
      phase: "completed",
      received: 10,
      total: 10,
    });
    expect((await first.next()).done).toBe(true);
    expect((await second.next()).value?.phase).toBe("completed");
    expect((await second.next()).done).toBe(true);

    const late = stream[Symbol.asyncIterator]();
    expect((await late.next()).value?.phase).toBe("completed");
    expect((await late.next()).done).toBe(true);
  });
});
