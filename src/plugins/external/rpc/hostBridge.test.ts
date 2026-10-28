import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginManifest, SpeechLevel } from "@keepdeck/plugin-api";
import { createHostBridge } from "./hostBridge";
import { decodeHostMessage } from "./decode";
import type {
  GuestToHostMessage,
  HostToGuestMessage,
  RpcResult,
} from "./protocol";
import { speechTranscript, speechCapture } from "@keepdeck/plugin-api/testing";

/**
 * Host-end tests driven with RAW protocol messages over a `MessageChannel` — no
 * guest runtime involved. They pin down the behaviours only reachable from the
 * wire: the handshake, an unknown path, a throwing member, and disposal failing
 * in-flight calls. (The full both-ends interlock lives in the guest package's
 * round-trip suite.)
 */

const manifest: PluginManifest = {
  id: "dev.example",
  name: "Example",
  version: "1.0.0",
  minApiVersion: 1,
  category: "deck",
  capabilities: [],
  contributes: {},
};

/** A do-nothing `PluginContext` with a recording logger — enough surface for the
 * host bridge to route onto; individual tests override the one member they poke. */
function makeStub(): { ctx: PluginContext; infos: string[] } {
  const infos: string[] = [];
  const disposable = { dispose() {} };
  const ctx: PluginContext = {
    manifest,
    ui: {
      registerDockTab: () => disposable,
      registerTopBarAction: () => disposable,
      registerPaneAction: () => disposable,
      registerOverlay: () => disposable,
      setOverlayVisible: () => {},
      setOverlayCovers: () => {},
    },
    openers: { register: () => disposable },
    commands: {
      register: () => disposable,
      execute: async () => ({ ok: true, value: null }),
      list: async () => [],
    },
    settings: {
      registerSection: () => disposable,
      read: async () => ({}),
      write: async () => {},
      onChange: () => disposable,
    },
    agents: { register: () => disposable },
    resources: { path: async () => null },
    workspaces: { dir: async () => "/plugin-workspaces/p/ws" },
    storage: {
      workspace: () => ({
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      }),
      global: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      },
    },
    events: {
      onWorkspaceClosed: () => disposable,
      onPaneSelected: () => disposable,
      onDeckChanged: () => disposable,
    },
    services: {
      downloads: {
        async *start() {},
        cancel: async () => {},
        exists: async () => false,
        remove: async () => {},
      },
      speech: {
        engines: async () => ["whisper"],
        devices: async () => [],
        startCapture: async () => speechCapture({
          stop: async () => speechTranscript({ text: "", seconds: 0, level: 0 }),
          cancel: async () => {},
        }),
      },
      clipboard: {
        writeText: async () => {},
        readText: async () => "",
      },
      exec: { runOnce: async () => ({ ran: true, ok: true, said: "" }) },
      rpc: { request: async () => ({ result: "{}", sentAt: 1 }) },
      http: { get: async () => ({ status: 200, body: "{}", truncated: false, sentAt: 1 }) },
      env: { get: async () => null },
      sessions: {
        spawn: async () => ({
          id: "s1",
          write: async () => {},
          resize: async () => {},
          close: async () => {},
        }),
      },
      ports: { allocate: async () => 0 },
      opener: { openUrl: async () => {}, openPath: async () => {}, openPathWith: async () => {} },
      fs: {
        readDir: async () => [],
        readFile: async (path: string) => ({
          path,
          text: "",
          isBinary: false,
          size: 0,
          truncated: false,
          readBytes: 0,
        }),
        watch: () => ({ ready: Promise.resolve(), dispose() {} }),
      },
      sessionStore: {
        read: async () => ({ payloadBytes: 0, items: 0, stopped: "exhausted" as const }),
      },
      sqlite: {
        query: async () => ({ rows: [], stopped: "exhausted" as const, payloadBytes: 0 }),
      },
      fsWrite: {
        mkdir: async () => {},
        copyFile: async () => {},
        remove: async () => {},
        writeFile: async () => {},
        appendLine: async () => {},
        move: async () => {},
      },
      git: {
        status: async () => ({
          branch: null,
          detached: false,
          oid: null,
          upstream: null,
          ahead: null,
          behind: null,
          entries: [],
        }),
        diffFile: async () => ({ text: "", truncated: false }),
        fileAt: async () => null,
        history: async () => ({ forkSha: null, ahead: null, commits: [] }),
        branches: async () => ({ current: null, branches: [] }),
        changedFiles: async () => [],
        watch: () => ({ ready: Promise.resolve(), dispose() {} }),
      },
    },
    host: { settings: async () => ({ terminalScrollback: 1000 }) },
    log: {
      info: (m) => void infos.push(m),
      warn: () => {},
      error: () => {},
    },
    notify: () => {},
  };
  return { ctx, infos };
}

const openPorts: MessagePort[] = [];
afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

function driver(ctx: PluginContext) {
  const channel = new MessageChannel();
  openPorts.push(channel.port1, channel.port2);
  const bridge = createHostBridge(channel.port1, ctx);
  const inbox: HostToGuestMessage[] = [];
  channel.port2.onmessage = (event) => inbox.push(decodeHostMessage(event.data));
  const send = (message: GuestToHostMessage) => channel.port2.postMessage(message);
  const results = () => inbox.filter((m): m is RpcResult => m.kind === "result");
  return { bridge, inbox, send, results };
}

describe("createHostBridge", () => {
  it("answers `ready` with `init` carrying the manifest", async () => {
    const { inbox, send } = driver(makeStub().ctx);
    send({ kind: "ready" });
    await flush();
    expect(inbox).toEqual([{ kind: "init", manifest }]);
  });

  it("answers a second `ready` with nothing — init happens once", async () => {
    const { inbox, send } = driver(makeStub().ctx);
    send({ kind: "ready" });
    send({ kind: "ready" });
    await flush();
    // Exactly one init: a re-driven guest can't multiply its registrations.
    expect(inbox.filter((m) => m.kind === "init")).toHaveLength(1);
  });

  it("rejects an Object.prototype path — the unknown-method guard holds", async () => {
    const { ctx } = makeStub();
    const { send, results } = driver(ctx);
    for (const path of ["constructor", "__proto__", "toString"]) {
      send({ kind: "call", id: 1, path, args: [] });
    }
    await flush();
    expect(results().every((r) => r.ok === false)).toBe(true);
  });

  it("answers an unknown path with ok:false and keeps serving", async () => {
    const { ctx, infos } = makeStub();
    const { send, results } = driver(ctx);

    send({ kind: "call", id: 1, path: "nope.nope", args: [] });
    send({ kind: "call", id: 2, path: "log.info", args: ["hi"] });
    await flush();

    const first = results().find((r) => r.id === 1);
    const second = results().find((r) => r.id === 2);
    expect(first).toMatchObject({ ok: false });
    expect(second).toEqual({ kind: "result", id: 2, ok: true, value: undefined });
    expect(infos).toEqual(["hi"]);
  });

  it("answers a throwing member with ok:false carrying its message", async () => {
    const { ctx } = makeStub();
    ctx.storage.global.get = () => {
      throw new Error("boom");
    };
    const { send, results } = driver(ctx);

    send({ kind: "call", id: 1, path: "storage.global.get", args: ["k"] });
    await flush();

    expect(results()[0]).toEqual({
      kind: "result",
      id: 1,
      ok: false,
      error: "boom",
    });
  });

  it("carries a thrown error's string code — a speech error's kind — to the guest", async () => {
    const { ctx } = makeStub();
    ctx.storage.global.get = () => {
      throw Object.assign(new Error("no microphone input device"), { code: "no-device" });
    };
    const { send, results } = driver(ctx);

    send({ kind: "call", id: 1, path: "storage.global.get", args: ["k"] });
    await flush();

    expect(results()[0]).toEqual({
      kind: "result",
      id: 1,
      ok: false,
      error: "no microphone input device",
      code: "no-device",
    });
  });

  it("fails every in-flight call when disposed", async () => {
    const { ctx } = makeStub();
    // A member that never settles — the only way its call ends is disposal.
    ctx.services.ports.allocate = () => new Promise<number>(() => {});
    const { bridge, send, results } = driver(ctx);

    send({ kind: "call", id: 7, path: "services.ports.allocate", args: ["k"] });
    await flush();
    expect(results()).toHaveLength(0);

    bridge.dispose();
    await flush();

    const result = results().find((r) => r.id === 7);
    expect(result).toMatchObject({ ok: false });
    expect(result?.ok === false && result.error).toMatch(/disposed/);
  });

  it("proxies speech as an owned handle and cancels it on disposal", async () => {
    const { ctx } = makeStub();
    const stop = vi.fn(async () => speechTranscript({ text: "hello", seconds: 1, level: 0.1 }));
    const cancel = vi.fn(async () => {});
    let emitLevel: ((rms: number, level: SpeechLevel) => void) | undefined;
    ctx.services.speech.startCapture = vi.fn(async (onLevel) => {
      emitLevel = onLevel;
      return speechCapture({ stop, cancel });
    });
    const { bridge, inbox, send, results } = driver(ctx);

    send({ kind: "call", id: 1, path: "services.speech.start", args: [7] });
    await flush();
    expect(results()).toContainEqual({
      kind: "result",
      id: 1,
      ok: true,
      value: { device: "Test Microphone", deviceMissing: false },
    });
    // The whole reading crosses to the realm, not just the RMS.
    const reading = { rms: 0.4, peak: 1, clipped: true, dcOffset: 0.3 };
    emitLevel?.(0.4, reading);
    await flush();
    expect(inbox).toContainEqual({ kind: "event", channel: "speech:7", payload: reading });

    send({
      kind: "call",
      id: 2,
      path: "services.speech.stop",
      args: [7, { engine: "whisper", modelPath: "models/a.bin" }],
    });
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(results()).toContainEqual({
      kind: "result",
      id: 2,
      ok: true,
      value: speechTranscript({ text: "hello", seconds: 1, level: 0.1 }),
    });

    send({ kind: "call", id: 3, path: "services.speech.start", args: [8] });
    await flush();
    bridge.dispose();
    await flush();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
