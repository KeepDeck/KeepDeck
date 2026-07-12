import { describe, expect, it, vi } from "vitest";
import type {
  Capability,
  PluginManifest,
  PluginSessionHandle,
  PluginSpawnOptions,
} from "@keepdeck/plugin-api";
import { createCapabilityGate, type ServiceBackends } from "./gate";

const manifest = (capabilities: Capability[]): PluginManifest => ({
  id: "p",
  name: "p",
  version: "1.0.0",
  minApiVersion: 1,
  category: "deck",
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
  const backend: ServiceBackends = {
    sessions: { spawn: vi.fn(async () => handle) },
    opener: {
      openUrl: vi.fn(async () => {}),
      openPath: vi.fn(async () => {}),
      openPathWith: vi.fn(async () => {}),
    },
    ports: { allocate: vi.fn(async () => 4000) },
    fs: {
      readDir: vi.fn(async () => []),
      readFile: vi.fn(async (path: string) => ({
        path,
        text: "",
        isBinary: false,
        size: 0,
        truncated: false,
      })),
      watch: vi.fn(() => ({ dispose: vi.fn() })),
    },
    git: {
      status: vi.fn(async () => ({
        branch: null,
        detached: false,
        oid: null,
        upstream: null,
        ahead: null,
        behind: null,
        entries: [],
      })),
      diffFile: vi.fn(async () => ""),
      history: vi.fn(async () => ({ forkSha: null, ahead: null, commits: [] })),
      branches: vi.fn(async () => ({ current: null, branches: [] })),
      changedFiles: vi.fn(async () => []),
      watch: vi.fn(() => ({ dispose: vi.fn() })),
    },
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

  it("opener: allowed with the open capability, forwarded verbatim", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "open" }]),
      backend,
      { mode: "enforce", log },
    );
    await gate.opener.openUrl("http://localhost:3000");
    await gate.opener.openPath("/tmp/report.html");
    await gate.opener.openPathWith("/repo", "Visual Studio Code");
    expect(backend.opener.openUrl).toHaveBeenCalledWith("http://localhost:3000");
    expect(backend.opener.openPath).toHaveBeenCalledWith("/tmp/report.html");
    expect(backend.opener.openPathWith).toHaveBeenCalledWith(
      "/repo",
      "Visual Studio Code",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("opener: missing capability warns-and-forwards in warn mode, throws in enforce", async () => {
    const warn = { ...fakeBackend(), log: fakeLog() };
    const warnGate = createCapabilityGate(manifest([]), warn.backend, {
      mode: "warn",
      log: warn.log,
    });
    await warnGate.opener.openUrl("http://x");
    expect(warn.log.warn).toHaveBeenCalledTimes(1);
    expect(warn.log.warn.mock.calls[0][0]).toContain('"open" capability');
    expect(warn.backend.opener.openUrl).toHaveBeenCalledTimes(1);

    const hard = { ...fakeBackend(), log: fakeLog() };
    const hardGate = createCapabilityGate(manifest([]), hard.backend, {
      mode: "enforce",
      log: hard.log,
    });
    expect(() => hardGate.opener.openPath("/etc/hosts")).toThrow(
      '"open" capability',
    );
    expect(hard.backend.opener.openPath).not.toHaveBeenCalled();
    expect(() => hardGate.opener.openPathWith("/repo", "Zed")).toThrow(
      '"open" capability',
    );
    expect(hard.backend.opener.openPathWith).not.toHaveBeenCalled();
  });
});

describe("createCapabilityGate — fs", () => {
  it("forwards a declared call and passes the derived scope, defaulting to workspace", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "fs", scope: "workspace" }]),
      backend,
      { mode: "enforce", log },
    );

    await gate.fs.readDir("/repo/src");
    await gate.fs.readFile("/repo/src/main.rs", { maxBytes: 100 });

    // The plugin never supplies the scope — the gate injects it from the
    // manifest as the backend's second argument.
    expect(backend.fs.readDir).toHaveBeenCalledWith("/repo/src", "workspace");
    expect(backend.fs.readFile).toHaveBeenCalledWith(
      "/repo/src/main.rs",
      "workspace",
      { maxBytes: 100 },
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("passes the everywhere scope through when the manifest declares it", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "fs", scope: "everywhere" }]),
      backend,
      { mode: "enforce", log },
    );

    await gate.fs.readDir("/anywhere");

    expect(backend.fs.readDir).toHaveBeenCalledWith("/anywhere", "everywhere");
  });

  it("missing fs capability warns-and-forwards in warn mode, throws in enforce", async () => {
    const warn = { ...fakeBackend(), log: fakeLog() };
    const warnGate = createCapabilityGate(manifest([]), warn.backend, {
      mode: "warn",
      log: warn.log,
    });
    // A warn-mode call with no fs capability still proceeds, but is contained
    // to the safe default scope — never silently promoted to everywhere.
    await warnGate.fs.readDir("/repo");
    expect(warn.log.warn).toHaveBeenCalledTimes(1);
    expect(warn.log.warn.mock.calls[0][0]).toContain('"fs" capability');
    expect(warn.backend.fs.readDir).toHaveBeenCalledWith("/repo", "workspace");

    const hard = { ...fakeBackend(), log: fakeLog() };
    const hardGate = createCapabilityGate(manifest([]), hard.backend, {
      mode: "enforce",
      log: hard.log,
    });
    expect(() => hardGate.fs.readFile("/etc/passwd")).toThrow('"fs" capability');
    expect(hard.backend.fs.readFile).not.toHaveBeenCalled();
  });

  it("forwards fs.watch with the derived scope and hands back the backend's disposable", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "fs", scope: "workspace" }]),
      backend,
      { mode: "enforce", log },
    );
    const onChange = vi.fn();

    gate.fs.watch("/repo/src", onChange);

    expect(backend.fs.watch).toHaveBeenCalledWith(
      "/repo/src",
      "workspace",
      onChange,
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("refuses fs.watch without the fs capability in enforce mode", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      mode: "enforce",
      log,
    });
    expect(() => gate.fs.watch("/repo", vi.fn())).toThrow('"fs" capability');
    expect(backend.fs.watch).not.toHaveBeenCalled();
  });
});

describe("createCapabilityGate — git", () => {
  it("forwards declared calls with the derived scope; the fs capability does NOT cover git", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "git", scope: "workspace" }]),
      backend,
      { mode: "enforce", log },
    );
    const onChange = vi.fn();

    await gate.git.status("/repo");
    await gate.git.diffFile("/repo", "src/main.rs", { staged: true });
    gate.git.watch("/repo", onChange);

    expect(backend.git.status).toHaveBeenCalledWith("/repo", "workspace");
    expect(backend.git.diffFile).toHaveBeenCalledWith(
      "/repo",
      "src/main.rs",
      "workspace",
      { staged: true },
    );
    expect(backend.git.watch).toHaveBeenCalledWith("/repo", "workspace", onChange);
    expect(log.warn).not.toHaveBeenCalled();

    // fs and git are separate grants: an fs-only manifest gets no git service.
    const fsOnly = fakeBackend();
    const fsOnlyGate = createCapabilityGate(
      manifest([{ kind: "fs", scope: "everywhere" }]),
      fsOnly.backend,
      { mode: "enforce", log: fakeLog() },
    );
    expect(() => fsOnlyGate.git.status("/repo")).toThrow('"git" capability');
    expect(fsOnly.backend.git.status).not.toHaveBeenCalled();
  });

  it("gates history and changedFiles like the other git reads, scope included", async () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "git", scope: "workspace" }]),
      backend,
      { mode: "enforce", log: fakeLog() },
    );

    await gate.git.history("/repo", { base: "main" });
    await gate.git.changedFiles("/repo", "abc123", "def456");

    expect(backend.git.history).toHaveBeenCalledWith("/repo", "workspace", {
      base: "main",
    });
    expect(backend.git.changedFiles).toHaveBeenCalledWith(
      "/repo",
      "abc123",
      "def456",
      "workspace",
    );

    const bare = fakeBackend();
    const bareGate = createCapabilityGate(manifest([]), bare.backend, {
      mode: "enforce",
      log: fakeLog(),
    });
    expect(() => bareGate.git.history("/repo")).toThrow('"git" capability');
    expect(() => bareGate.git.changedFiles("/repo", "abc123")).toThrow(
      '"git" capability',
    );
    expect(bare.backend.git.history).not.toHaveBeenCalled();
    expect(bare.backend.git.changedFiles).not.toHaveBeenCalled();
  });

  it("passes the everywhere scope through; git scope is derived from git, not fs", async () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([
        { kind: "fs", scope: "workspace" },
        { kind: "git", scope: "everywhere" },
      ]),
      backend,
      { mode: "enforce", log: fakeLog() },
    );

    await gate.git.status("/anywhere");

    expect(backend.git.status).toHaveBeenCalledWith("/anywhere", "everywhere");
  });

  it("missing git capability warns-and-forwards in warn mode with the safe scope, throws in enforce", async () => {
    const warn = { ...fakeBackend(), log: fakeLog() };
    const warnGate = createCapabilityGate(manifest([]), warn.backend, {
      mode: "warn",
      log: warn.log,
    });
    await warnGate.git.status("/repo");
    expect(warn.log.warn).toHaveBeenCalledTimes(1);
    expect(warn.log.warn.mock.calls[0][0]).toContain('"git" capability');
    expect(warn.backend.git.status).toHaveBeenCalledWith("/repo", "workspace");

    const hard = { ...fakeBackend(), log: fakeLog() };
    const hardGate = createCapabilityGate(manifest([]), hard.backend, {
      mode: "enforce",
      log: hard.log,
    });
    expect(() => hardGate.git.diffFile("/repo", "a.ts")).toThrow(
      '"git" capability',
    );
    expect(() => hardGate.git.watch("/repo", vi.fn())).toThrow(
      '"git" capability',
    );
    expect(hard.backend.git.diffFile).not.toHaveBeenCalled();
    expect(hard.backend.git.watch).not.toHaveBeenCalled();
  });
});
