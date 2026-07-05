import { describe, expect, it, vi } from "vitest";
import type {
  Capability,
  PluginManifest,
  PluginServices,
  PluginSessionHandle,
  PluginSpawnOptions,
} from "@keepdeck/plugin-api";
import { createCapabilityGate } from "./gate";

const manifest = (capabilities: Capability[]): PluginManifest => ({
  id: "p",
  name: "p",
  version: "1.0.0",
  minApiVersion: "0.0.1",
  capabilities,
  contributes: {},
});

const spawnOpts = (command?: string | null): PluginSpawnOptions => ({
  ...(command === undefined ? {} : { command }),
  cols: 80,
  rows: 24,
});

function fakeBackend() {
  const handle: PluginSessionHandle = {
    id: "h1",
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  };
  const backend: PluginServices = {
    sessions: { spawn: vi.fn(async () => handle) },
    ports: { allocate: vi.fn(async () => 4000) },
  };
  return { backend, handle };
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("createCapabilityGate — sessions.spawn", () => {
  it("forwards an exact-match exec call verbatim: same args, backend's own returned handle", async () => {
    const { backend, handle } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["git"] }]),
      backend,
      { mode: "enforce", log },
    );
    const opts = spawnOpts("git");
    const onEvent = vi.fn();

    const result = gate.sessions.spawn(opts, onEvent);

    expect(backend.sessions.spawn).toHaveBeenCalledTimes(1);
    expect(backend.sessions.spawn).toHaveBeenCalledWith(opts, onEvent);
    // Verbatim forwarding: the gate hands back the exact promise the backend
    // produced, not a rewrapped one, and it resolves to the backend's own
    // handle — never re-wrapped.
    expect(result).toBe(
      (backend.sessions.spawn as ReturnType<typeof vi.fn>).mock.results[0].value,
    );
    expect(await result).toBe(handle);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("covers an absolute path by the declared command's basename", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["git"] }]),
      backend,
      { mode: "enforce", log },
    );

    await gate.sessions.spawn(spawnOpts("/usr/bin/git"), vi.fn());

    expect(backend.sessions.spawn).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("requires the literal \"$SHELL\" capability for an omitted command", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["$SHELL"] }]),
      backend,
      { mode: "enforce", log },
    );

    await gate.sessions.spawn(spawnOpts(undefined), vi.fn());

    expect(backend.sessions.spawn).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("an omitted command without a \"$SHELL\" capability is a violation", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["git"] }]),
      backend,
      { mode: "enforce", log },
    );

    expect(() => gate.sessions.spawn(spawnOpts(undefined), vi.fn())).toThrow(
      /\$SHELL.*exec/,
    );
    expect(backend.sessions.spawn).not.toHaveBeenCalled();
  });

  it("the \"*\" wildcard covers any program", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["*"] }]),
      backend,
      { mode: "enforce", log },
    );

    await gate.sessions.spawn(spawnOpts("anything-goes"), vi.fn());

    expect(backend.sessions.spawn).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warn mode logs exactly one precise warning naming the subject, and still forwards the call", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      mode: "warn",
      log,
    });

    await gate.sessions.spawn(spawnOpts("curl"), vi.fn());

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("curl"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("exec"));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("sessions.spawn"),
    );
    expect(backend.sessions.spawn).toHaveBeenCalledTimes(1);
  });

  it("enforce mode throws and never calls the backend", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      mode: "enforce",
      log,
    });

    expect(() => gate.sessions.spawn(spawnOpts("curl"), vi.fn())).toThrow(
      /curl.*exec/,
    );
    expect(backend.sessions.spawn).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("createCapabilityGate — ports.allocate", () => {
  it("forwards an allowed call verbatim: same key, backend's own returned value", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([{ kind: "ports" }]), backend, {
      mode: "enforce",
      log,
    });

    const result = gate.ports.allocate("preview-server");

    expect(backend.ports.allocate).toHaveBeenCalledTimes(1);
    expect(backend.ports.allocate).toHaveBeenCalledWith("preview-server");
    expect(result).toBe(
      (backend.ports.allocate as ReturnType<typeof vi.fn>).mock.results[0]
        .value,
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warn mode logs one precise warning and still forwards the call", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      mode: "warn",
      log,
    });

    await gate.ports.allocate("preview-server");

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("preview-server"),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ports"));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("ports.allocate"),
    );
    expect(backend.ports.allocate).toHaveBeenCalledTimes(1);
  });

  it("enforce mode throws and never calls the backend", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      mode: "enforce",
      log,
    });

    expect(() => gate.ports.allocate("preview-server")).toThrow(/ports/);
    expect(backend.ports.allocate).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("createCapabilityGate — zero capabilities", () => {
  it("a manifest with no capabilities gets every call warned in \"warn\" mode", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      mode: "warn",
      log,
    });

    await gate.sessions.spawn(spawnOpts("git"), vi.fn());
    await gate.ports.allocate("k");

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(backend.sessions.spawn).toHaveBeenCalledTimes(1);
    expect(backend.ports.allocate).toHaveBeenCalledTimes(1);
  });

  it("a manifest with no capabilities gets every call refused in \"enforce\" mode", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      mode: "enforce",
      log,
    });

    expect(() => gate.sessions.spawn(spawnOpts("git"), vi.fn())).toThrow();
    expect(() => gate.ports.allocate("k")).toThrow();
    expect(backend.sessions.spawn).not.toHaveBeenCalled();
    expect(backend.ports.allocate).not.toHaveBeenCalled();
  });
});
