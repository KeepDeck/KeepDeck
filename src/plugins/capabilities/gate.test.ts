import { describe, expect, it, vi } from "vitest";
import type {
  Capability,
  DownloadRequest,
  PluginManifest,
  PluginSessionHandle,
  PluginSpawnOptions,
} from "@keepdeck/plugin-api";
import { createCapabilityGate, type ServiceBackends } from "./gate";
import { NO_PERMISSIONS, type ResolvedPermissions } from "./permissions";
import { speechTranscript, speechCapture } from "@keepdeck/plugin-api/testing";
import { recordOf, stringOf } from "../../testing/values.test-support";

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
    downloads: {
      start: vi.fn(async function* () {}),
      cancel: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      remove: vi.fn(async () => {}),
    },
    speech: {
      engines: vi.fn(async () => ["whisper" as const]),
      devices: vi.fn(async () => []),
      startCapture: vi.fn(async () => speechCapture({
        stop: vi.fn(async () => speechTranscript({ text: "", seconds: 0, level: 0 })),
        cancel: vi.fn(async () => {}),
      })),
    },
    clipboard: {
      writeText: vi.fn(async () => {}),
      readText: vi.fn(async () => ""),
    },
    exec: { runOnce: vi.fn(async () => ({ ran: true, ok: true, said: "" })) },
    rpc: {
      request: vi.fn(async () => ({ result: "{}", sentAt: 1 })),
      stop: vi.fn(async () => {}),
    },
    sessions: { spawn: vi.fn(async () => handle) },
    opener: {
      openUrl: vi.fn(async () => {}),
      openPath: vi.fn(async () => {}),
      openPathWith: vi.fn(async () => {}),
    },
    ports: { allocate: vi.fn(async () => 4000) },
    http: { get: vi.fn(async () => ({ status: 200, body: "{}", truncated: false, sentAt: 1 })) },
    fs: {
      readDir: vi.fn(async () => []),
      readFile: vi.fn(async (path: string) => ({
        path,
        text: "",
        isBinary: false,
        size: 0,
        truncated: false,
        readBytes: 0,
      })),
      watch: vi.fn(() => ({ ready: Promise.resolve(), dispose: vi.fn() })),
    },
    sqlite: {
      query: vi.fn(() =>
        Promise.resolve({ rows: [], stopped: "exhausted" as const, payloadBytes: 0 }),
      ),
    },
    fsWrite: {
      mkdir: vi.fn(() => Promise.resolve()),
      copyFile: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      writeFile: vi.fn(() => Promise.resolve()),
      appendLine: vi.fn(() => Promise.resolve()),
      move: vi.fn(() => Promise.resolve()),
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
      diffFile: vi.fn(async () => ({ text: "", truncated: false })),
      fileAt: vi.fn(async () => null),
      history: vi.fn(async () => ({ forkSha: null, ahead: null, commits: [] })),
      branches: vi.fn(async () => ({ current: null, branches: [] })),
      changedFiles: vi.fn(async () => []),
      watch: vi.fn(() => ({ ready: Promise.resolve(), dispose: vi.fn() })),
    },
  };
  return { backend, handle };
}

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const downloadRequest = (id = "job-1"): DownloadRequest => ({
  id,
  source: { url: "https://files.example.com/model.bin" },
  target: { kind: "file", path: "models/model.bin" },
});

describe("createCapabilityGate — sessions.spawn", () => {
  it("forwards an exact-match exec call verbatim: same args, backend's own returned handle", async () => {
    const { backend, handle } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["git"] }]),
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
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
      vi.mocked(backend.sessions.spawn).mock.results[0].value,
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
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
    );

    await gate.sessions.spawn(spawnOpts("/usr/bin/git"), vi.fn());

    expect(backend.sessions.spawn).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('requires the literal "$SHELL" capability for an omitted command', async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["$SHELL"] }]),
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
    );

    await gate.sessions.spawn(spawnOpts(undefined), vi.fn());

    expect(backend.sessions.spawn).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('an omitted command without a "$SHELL" capability is a violation', () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["git"] }]),
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
    );

    expect(() => gate.sessions.spawn(spawnOpts(undefined), vi.fn())).toThrow(
      /\$SHELL.*exec/,
    );
    expect(backend.sessions.spawn).not.toHaveBeenCalled();
  });

  it('a literal "*" entry is not a wildcard — the gate still denies', () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    // `readManifest` refuses a bare "*" now, so no installed plugin declares
    // one; a hand-built manifest carrying it must not spawn anything either.
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["*"] }]),
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
    );

    expect(() => gate.sessions.spawn(spawnOpts("anything-goes"), vi.fn())).toThrow(
      /exec/,
    );
    expect(backend.sessions.spawn).not.toHaveBeenCalled();
  });

  it("log diagnostics emits one precise warning and still denies the call", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      diagnostics: "log",
      permissions: NO_PERMISSIONS,
      log,
    });

    expect(() => gate.sessions.spawn(spawnOpts("curl"), vi.fn())).toThrow();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("curl"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("exec"));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("sessions.spawn"),
    );
    expect(backend.sessions.spawn).not.toHaveBeenCalled();
  });

  it("silent diagnostics throws and never calls the backend", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
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
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
      log,
    });

    const result = gate.ports.allocate("preview-server");

    expect(backend.ports.allocate).toHaveBeenCalledTimes(1);
    expect(backend.ports.allocate).toHaveBeenCalledWith("preview-server");
    expect(result).toBe(
      vi.mocked(backend.ports.allocate).mock.results[0].value,
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("log diagnostics emits one precise warning and still denies the call", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      diagnostics: "log",
      permissions: NO_PERMISSIONS,
      log,
    });

    expect(() => gate.ports.allocate("preview-server")).toThrow();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("preview-server"),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ports"));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("ports.allocate"),
    );
    expect(backend.ports.allocate).not.toHaveBeenCalled();
  });

  it("silent diagnostics throws and never calls the backend", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
      log,
    });

    expect(() => gate.ports.allocate("preview-server")).toThrow(/ports/);
    expect(backend.ports.allocate).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("createCapabilityGate — downloads", () => {
  it("names the plugin and hands over no reach — the native side holds every hop to its grant", () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(manifest([{ kind: "net", domains: ["files.example.com"] }]), backend, {
      diagnostics: "silent",
      log: fakeLog(),
      permissions: NO_PERMISSIONS,
    });
    const request = downloadRequest();

    gate.downloads.start(request);

    expect(backend.downloads.start).toHaveBeenCalledWith("p", request, expect.any(Function));
  });

  it("uses the job id alone and only cancels jobs started by this plugin", () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "net", domains: ["files.example.com"] }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );

    gate.downloads.start(downloadRequest());
    expect(() => gate.downloads.start(downloadRequest())).toThrow(
      "download id already used",
    );
    gate.downloads.cancel("job-1");
    expect(backend.downloads.cancel).toHaveBeenCalledWith("job-1");
    expect(() => gate.downloads.cancel("foreign-job")).toThrow(
      "was not started by this plugin",
    );
  });

  it("does not grant cancel ownership when the backend rejects start", () => {
    const { backend } = fakeBackend();
    backend.downloads.start = vi.fn(() => {
      throw new Error("global id collision");
    });
    const gate = createCapabilityGate(
      manifest([{ kind: "net", domains: ["files.example.com"] }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );
    expect(() => gate.downloads.start(downloadRequest())).toThrow(
      "global id collision",
    );
    expect(() => gate.downloads.cancel("job-1")).toThrow(
      "was not started by this plugin",
    );
    expect(backend.downloads.cancel).not.toHaveBeenCalled();
  });

  it("bounds one plugin's active downloads", () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "net", domains: ["files.example.com"] }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );
    for (let index = 0; index < 8; index++) {
      gate.downloads.start(downloadRequest(`job-${index}`));
    }
    expect(() => gate.downloads.start(downloadRequest("overflow"))).toThrow(
      "too many active downloads",
    );
    expect(backend.downloads.start).toHaveBeenCalledTimes(8);
  });
});

describe("createCapabilityGate — env and http", () => {
  const signed: ResolvedPermissions = {
    env: { TOOL_HOME: "/custom", TOOL_BASE_URL: null },
    net: [
      { allow: ["127.0.0.1"], credentials: [] },
      {
        allow: ["api.tool.example", "https://custom.example:8443"],
        credentials: [{ id: "tool", dir: "/custom/credentials", tokenFields: ["access_token"] }],
      },
    ],
  };
  const gateWith = (capabilities: Capability[], permissions: ResolvedPermissions) => {
    const { backend } = fakeBackend();
    return {
      backend,
      gate: createCapabilityGate(manifest(capabilities), backend, { diagnostics: "silent", log: fakeLog(), permissions }),
    };
  };
  const declared: Capability[] = [{ kind: "env", names: ["TOOL_HOME", "TOOL_BASE_URL"] }];

  it("answers a declared variable from the resolution and an undeclared one as absent", async () => {
    const { gate } = gateWith(declared, { ...signed, env: { ...signed.env, SECRET: "leak" } });
    await expect(gate.env.get("TOOL_HOME")).resolves.toBe("/custom");
    await expect(gate.env.get("TOOL_BASE_URL")).resolves.toBeNull();
    // Even a value the resolution carried is not handed out undeclared.
    await expect(gate.env.get("SECRET")).resolves.toBeNull();
  });

  it("hands a request over as the plugin's own, with nothing of its grant", async () => {
    // The reach and the credential are looked up natively by plugin id: the
    // gate holding a resolution must not pass any of it, or a caller could
    // pass a wider one.
    const { backend, gate } = gateWith(declared, signed);
    const request = { url: "https://custom.example:8443/usages", credential: { source: "tool", file: "t.json" } };

    await gate.http.get(request);

    expect(backend.http.get).toHaveBeenCalledWith("p", request);
  });
});

describe("createCapabilityGate — zero capabilities", () => {
  it("a manifest with no capabilities logs and refuses every call with log diagnostics", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      diagnostics: "log",
      permissions: NO_PERMISSIONS,
      log,
    });

    expect(() => gate.sessions.spawn(spawnOpts("git"), vi.fn())).toThrow();
    expect(() => gate.ports.allocate("k")).toThrow();

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(backend.sessions.spawn).not.toHaveBeenCalled();
    expect(backend.ports.allocate).not.toHaveBeenCalled();
  });

  it('a manifest with no capabilities gets every call refused in "enforce" mode', () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
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
    const gate = createCapabilityGate(manifest([{ kind: "open" }]), backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
      log,
    });
    await gate.opener.openUrl("http://localhost:3000");
    await gate.opener.openPath("/tmp/report.html");
    await gate.opener.openPathWith("/repo", "Visual Studio Code");
    expect(backend.opener.openUrl).toHaveBeenCalledWith(
      "http://localhost:3000",
    );
    expect(backend.opener.openPath).toHaveBeenCalledWith("/tmp/report.html");
    expect(backend.opener.openPathWith).toHaveBeenCalledWith(
      "/repo",
      "Visual Studio Code",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("opener: missing capability is denied in both modes", () => {
    const warn = { ...fakeBackend(), log: fakeLog() };
    const warnGate = createCapabilityGate(manifest([]), warn.backend, {
      diagnostics: "log",
      permissions: NO_PERMISSIONS,
      log: warn.log,
    });
    expect(() => warnGate.opener.openUrl("http://x")).toThrow();
    expect(warn.log.warn).toHaveBeenCalledTimes(1);
    expect(warn.log.warn.mock.calls[0][0]).toContain('"open" capability');
    expect(warn.backend.opener.openUrl).not.toHaveBeenCalled();

    const hard = { ...fakeBackend(), log: fakeLog() };
    const hardGate = createCapabilityGate(manifest([]), hard.backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
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

describe("createCapabilityGate — clipboard", () => {
  it("writeText is admitted by clipboardWrite and forwarded verbatim", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "clipboardWrite" }]),
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
    );

    await gate.clipboard.writeText("hello");

    expect(backend.clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("readText is admitted by clipboardRead and forwarded verbatim", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "clipboardRead" }]),
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
    );

    await gate.clipboard.readText();

    expect(backend.clipboard.readText).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("the split is enforced: clipboardWrite does NOT grant read (the sensitive direction)", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "clipboardWrite" }]),
      backend,
      { diagnostics: "log", log, permissions: NO_PERMISSIONS },
    );

    expect(() => gate.clipboard.readText()).toThrow('"clipboardRead" capability');
    expect(backend.clipboard.readText).not.toHaveBeenCalled();
    // Write still works — only the undeclared direction is refused.
    expect(() => gate.clipboard.writeText("x")).not.toThrow();
  });

  it("the split is enforced: clipboardRead does NOT grant write", () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "clipboardRead" }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );

    expect(() => gate.clipboard.writeText("x")).toThrow(
      '"clipboardWrite" capability',
    );
    expect(backend.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("with neither capability declared, both directions are denied", () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(manifest([]), backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
      log: fakeLog(),
    });

    expect(() => gate.clipboard.writeText("x")).toThrow('"clipboardWrite"');
    expect(() => gate.clipboard.readText()).toThrow('"clipboardRead"');
    expect(backend.clipboard.writeText).not.toHaveBeenCalled();
    expect(backend.clipboard.readText).not.toHaveBeenCalled();
  });

  it("declaring BOTH capabilities admits both directions together", async () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "clipboardWrite" }, { kind: "clipboardRead" }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );

    await gate.clipboard.writeText("both");
    await gate.clipboard.readText();

    expect(backend.clipboard.writeText).toHaveBeenCalledWith("both");
    expect(backend.clipboard.readText).toHaveBeenCalledTimes(1);
  });
});

describe("createCapabilityGate — fs", () => {
  it("forwards a declared call and passes the derived scope, defaulting to workspace", async () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "fs", scope: "workspace" }]),
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
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
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
    );

    await gate.fs.readDir("/anywhere");

    expect(backend.fs.readDir).toHaveBeenCalledWith("/anywhere", "everywhere");
  });

  it("missing fs capability is denied in both modes", () => {
    const warn = { ...fakeBackend(), log: fakeLog() };
    const warnGate = createCapabilityGate(manifest([]), warn.backend, {
      diagnostics: "log",
      permissions: NO_PERMISSIONS,
      log: warn.log,
    });
    expect(() => warnGate.fs.readDir("/repo")).toThrow();
    expect(warn.log.warn).toHaveBeenCalledTimes(1);
    expect(warn.log.warn.mock.calls[0][0]).toContain('"fs" capability');
    expect(warn.backend.fs.readDir).not.toHaveBeenCalled();

    const hard = { ...fakeBackend(), log: fakeLog() };
    const hardGate = createCapabilityGate(manifest([]), hard.backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
      log: hard.log,
    });
    expect(() => hardGate.fs.readFile("/etc/passwd")).toThrow(
      '"fs" capability',
    );
    expect(hard.backend.fs.readFile).not.toHaveBeenCalled();
  });

  it("forwards fs.watch with the derived scope and hands back the backend's disposable", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(
      manifest([{ kind: "fs", scope: "workspace" }]),
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
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

  it("answers the GitDiff whatever the plugin's floor", async () => {
    // The bare text an external plugin from before API 52 expects is the RPC
    // bridge's to hand out (hostServices); a built-in is compiled against the
    // GitDiff, so the gate never unwraps it.
    const { backend } = fakeBackend();
    backend.git.diffFile = vi.fn(async () => ({ text: "@@ -1 +1 @@\n", truncated: true }));
    const log = fakeLog();
    const older = createCapabilityGate(
      { ...manifest([{ kind: "git", scope: "workspace" }]), minApiVersion: 51 },
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
    );
    const current = createCapabilityGate(
      { ...manifest([{ kind: "git", scope: "workspace" }]), minApiVersion: 52 },
      backend,
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
    );

    await expect(older.git.diffFile("/repo", "a.ts")).resolves.toEqual({
      text: "@@ -1 +1 @@\n",
      truncated: true,
    });
    await expect(current.git.diffFile("/repo", "a.ts")).resolves.toEqual({
      text: "@@ -1 +1 @@\n",
      truncated: true,
    });
  });

  it("refuses fs.watch without the fs capability with silent diagnostics", () => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    const gate = createCapabilityGate(manifest([]), backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
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
      { diagnostics: "silent", log, permissions: NO_PERMISSIONS },
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
    expect(backend.git.watch).toHaveBeenCalledWith(
      "/repo",
      "workspace",
      onChange,
    );
    expect(log.warn).not.toHaveBeenCalled();

    // fs and git are separate grants: an fs-only manifest gets no git service.
    const fsOnly = fakeBackend();
    const fsOnlyGate = createCapabilityGate(
      manifest([{ kind: "fs", scope: "everywhere" }]),
      fsOnly.backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );
    expect(() => fsOnlyGate.git.status("/repo")).toThrow('"git" capability');
    expect(fsOnly.backend.git.status).not.toHaveBeenCalled();
  });

  it("gates history and changedFiles like the other git reads, scope included", async () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "git", scope: "workspace" }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
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
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
      log: fakeLog(),
    });
    expect(() => bareGate.git.history("/repo")).toThrow('"git" capability');
    expect(() => bareGate.git.changedFiles("/repo", "abc123")).toThrow(
      '"git" capability',
    );
    expect(bare.backend.git.history).not.toHaveBeenCalled();
    expect(bare.backend.git.changedFiles).not.toHaveBeenCalled();
  });

  it("gates fileAt like the other git reads, scope and revision included", async () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "git", scope: "workspace" }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );
    await gate.git.fileAt("/repo", "src/a.ts", "HEAD");
    await gate.git.fileAt("/repo", "src/a.ts");
    expect(vi.mocked(backend.git.fileAt).mock.calls).toEqual([
      ["/repo", "src/a.ts", "HEAD", "workspace"],
      ["/repo", "src/a.ts", undefined, "workspace"],
    ]);

    const bare = fakeBackend();
    const bareGate = createCapabilityGate(manifest([]), bare.backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
      log: fakeLog(),
    });
    expect(() => bareGate.git.fileAt("/repo", "a.ts")).toThrow('"git" capability');
    expect(bare.backend.git.fileAt).not.toHaveBeenCalled();
  });

  it("passes the everywhere scope through; git scope is derived from git, not fs", async () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([
        { kind: "fs", scope: "workspace" },
        { kind: "git", scope: "everywhere" },
      ]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );

    await gate.git.status("/anywhere");

    expect(backend.git.status).toHaveBeenCalledWith("/anywhere", "everywhere");
  });

  it("missing git capability is denied in both modes", () => {
    const warn = { ...fakeBackend(), log: fakeLog() };
    const warnGate = createCapabilityGate(manifest([]), warn.backend, {
      diagnostics: "log",
      permissions: NO_PERMISSIONS,
      log: warn.log,
    });
    expect(() => warnGate.git.status("/repo")).toThrow();
    expect(warn.log.warn).toHaveBeenCalledTimes(1);
    expect(warn.log.warn.mock.calls[0][0]).toContain('"git" capability');
    expect(warn.backend.git.status).not.toHaveBeenCalled();

    const hard = { ...fakeBackend(), log: fakeLog() };
    const hardGate = createCapabilityGate(manifest([]), hard.backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
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

describe("createCapabilityGate — fsWrite", () => {
  it("names the plugin on every write and hands over no root — where it may write is its native grant's", async () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(manifest([{ kind: "fsWrite", paths: ["~/.claude/projects"] }]), backend, {
      diagnostics: "silent",
      log: fakeLog(),
      permissions: NO_PERMISSIONS,
    });

    await gate.fsWrite.mkdir("~/.claude/projects/-x");
    await gate.fsWrite.copyFile("/a", "/b");
    await gate.fsWrite.copyFile("/s", "/d", { replace: [["/S/", "/F/"]] });
    await gate.fsWrite.remove("/gone");
    await gate.fsWrite.writeFile("/p", "text");
    await gate.fsWrite.appendLine("/p", "line");
    await gate.fsWrite.move("/built", "/live");

    expect(backend.fsWrite.mkdir).toHaveBeenCalledWith("p", "~/.claude/projects/-x");
    expect(backend.fsWrite.copyFile).toHaveBeenCalledWith("p", "/a", "/b", undefined);
    // The replacements ride through whole.
    expect(backend.fsWrite.copyFile).toHaveBeenCalledWith("p", "/s", "/d", { replace: [["/S/", "/F/"]] });
    expect(backend.fsWrite.remove).toHaveBeenCalledWith("p", "/gone");
    expect(backend.fsWrite.writeFile).toHaveBeenCalledWith("p", "/p", "text");
    expect(backend.fsWrite.appendLine).toHaveBeenCalledWith("p", "/p", "line");
    expect(backend.fsWrite.move).toHaveBeenCalledWith("p", "/built", "/live");
  });
});

describe("createCapabilityGate — sqlite", () => {
  it("names the plugin on a query and hands over no prefix", async () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "sqliteReadonly", paths: ["~/.local/share/opencode"] }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );

    await gate.sqlite.query("~/.local/share/opencode/opencode.db", "SELECT 1", ["a"]);
    expect(backend.sqlite.query).toHaveBeenCalledWith("p", "~/.local/share/opencode/opencode.db", "SELECT 1", ["a"]);
    // Omitted params normalize to an empty array before the backend.
    await gate.sqlite.query("/db", "SELECT 2");
    expect(backend.sqlite.query).toHaveBeenLastCalledWith("p", "/db", "SELECT 2", []);
  });
});

describe("createCapabilityGate — exec.runOnce", () => {
  const request = { key: "k", command: "git", args: ["status"] };

  it("admits a run the manifest's exec capability already covers", async () => {
    // The same permission as spawning it in a pane, asked for a quieter
    // shape — so declaring `exec` once must cover both roads.
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["git"] }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );

    await gate.exec.runOnce(request);

    // What the plugin asked for reaches the host verbatim — except the key,
    // which the gate namespaces (see the test below).
    expect(backend.exec.runOnce).toHaveBeenCalledWith(
      expect.objectContaining({ command: request.command, args: request.args }),
    );
  });

  it("namespaces the single-flight key by the asking plugin", async () => {
    // Keys are caller-chosen strings. Without a namespace two plugins can
    // collide, and a collision hands one of them the other's run result —
    // including the tail of its failing output.
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["git"] }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );

    await gate.exec.runOnce(request);

    const passed = recordOf(vi.mocked(backend.exec.runOnce).mock.calls[0][0], "exec request");
    expect(stringOf(passed.key, "exec key")).not.toBe(request.key);
    expect(stringOf(passed.key, "exec key").endsWith(`:${request.key}`)).toBe(true);
  });

  it("refuses a command no exec capability covers, and never reaches the host", () => {
    // The gate is where "may this plugin run this" is decided; the host
    // below it only refuses shapes nobody legitimate asks for.
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(
      manifest([{ kind: "exec", commands: ["git"] }]),
      backend,
      { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS },
    );

    expect(() => gate.exec.runOnce({ ...request, command: "curl" })).toThrow(
      /requires an "exec" capability/,
    );
    expect(backend.exec.runOnce).not.toHaveBeenCalled();
  });

  it("refuses every command when the manifest declares no exec at all", () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(manifest([]), backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
      log: fakeLog(),
    });

    expect(() => gate.exec.runOnce(request)).toThrow(/exec/);
    expect(backend.exec.runOnce).not.toHaveBeenCalled();
  });
});

describe("createCapabilityGate — rpc.request", () => {
  const server = {
    id: "app",
    command: "tool",
    args: ["serve"],
    handshake: { method: "init" },
    methods: ["read"],
  };
  const gateFor = (capabilities: Capability[]) => {
    const { backend } = fakeBackend();
    const log = fakeLog();
    return { backend, gate: createCapabilityGate(manifest(capabilities), backend, { diagnostics: "silent", log, permissions: NO_PERMISSIONS }) };
  };

  it("hands the backend the MANIFEST's server, the method and the params", async () => {
    const { backend, gate } = gateFor([{ kind: "exec", commands: ["tool"], servers: [server] }]);

    await expect(gate.rpc.request({ server: "app", method: "read", params: { n: 1 } })).resolves.toEqual({
      result: "{}",
      sentAt: 1,
    });

    expect(backend.rpc.request).toHaveBeenCalledWith("p", server, "read", { n: 1 });
  });

  it("fills a handshake's clientInfo version from the manifest, and keeps one the plugin states", async () => {
    const shaking = (clientInfo: Record<string, string>) => ({
      ...server,
      handshake: { method: "init", params: { clientInfo } },
    });
    const unversioned = gateFor([{ kind: "exec", commands: ["tool"], servers: [shaking({ name: "kd" })] }]);
    await unversioned.gate.rpc.request({ server: "app", method: "read" });
    expect(unversioned.backend.rpc.request).toHaveBeenCalledWith(
      "p",
      shaking({ name: "kd", version: "1.0.0" }),
      "read",
      undefined,
    );

    const stated = shaking({ name: "kd", version: "9.9.9" });
    const versioned = gateFor([{ kind: "exec", commands: ["tool"], servers: [stated] }]);
    await versioned.gate.rpc.request({ server: "app", method: "read" });
    expect(versioned.backend.rpc.request).toHaveBeenCalledWith("p", stated, "read", undefined);
  });

  it("refuses an undeclared server, an undeclared method, and a server outside the exec commands", () => {
    const declared = gateFor([{ kind: "exec", commands: ["tool"], servers: [server] }]);
    expect(() => declared.gate.rpc.request({ server: "other", method: "read" })).toThrow(/not declared/);
    expect(() => declared.gate.rpc.request({ server: "app", method: "write" })).toThrow(
      /not a declared method/,
    );
    expect(() => declared.gate.rpc.request({ server: "app", method: "init" })).toThrow(
      /not a declared method/,
    );
    // A manifest the validator would refuse, reaching the gate anyway: the
    // gate checks the command itself rather than trusting the validator.
    const stray = gateFor([{ kind: "exec", commands: ["git"], servers: [server] }]);
    expect(() => stray.gate.rpc.request({ server: "app", method: "read" })).toThrow(
      /not among the "exec" commands/,
    );
    expect(declared.backend.rpc.request).not.toHaveBeenCalled();
    expect(stray.backend.rpc.request).not.toHaveBeenCalled();
  });
});

describe("createCapabilityGate — speech", () => {
  it("refuses the microphone list and a capture to a plugin without the mic capability", () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(manifest([]), backend, { diagnostics: "silent", log: fakeLog(), permissions: NO_PERMISSIONS });
    expect(() => gate.speech.devices()).toThrow(/"mic" capability/);
    expect(() => gate.speech.startCapture()).toThrow(/"mic" capability/);
    expect(backend.speech.devices).not.toHaveBeenCalled();
    expect(backend.speech.startCapture).not.toHaveBeenCalled();
  });

  it("passes the device choice through, under the plugin's own id", async () => {
    const { backend } = fakeBackend();
    const gate = createCapabilityGate(manifest([{ kind: "mic" }]), backend, {
      diagnostics: "silent",
      permissions: NO_PERMISSIONS,
      log: fakeLog(),
    });
    const onLevel = vi.fn();
    await gate.speech.startCapture(onLevel, { deviceId: "coreaudio:usb" });
    expect(backend.speech.startCapture).toHaveBeenCalledWith("p", onLevel, { deviceId: "coreaudio:usb" });
    await gate.speech.devices();
    expect(backend.speech.devices).toHaveBeenCalledOnce();
  });
});
