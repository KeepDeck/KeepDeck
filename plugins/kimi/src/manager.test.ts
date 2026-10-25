import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@keepdeck/plugin-api";
import {
  COMPANION_DESCRIPTOR,
  COMPANION_ID,
  COMPANION_VERSION,
} from "./companion";
import { createKimiCompanionManager } from "./manager";
import type { KimiServerManager } from "./serverManager";

const SOURCE_DIRECTORY = "/App/resources/keepdeck-session-reporter";
const ACCESS = {
  origin: "http://127.0.0.1:64999",
  token: "secret-token",
};

function pluginSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPANION_ID,
    displayName: COMPANION_DESCRIPTOR.displayName,
    version: COMPANION_VERSION,
    enabled: true,
    state: "ok",
    hasErrors: false,
    source: "local-path",
    originalSource: SOURCE_DIRECTORY,
    ...overrides,
  };
}

function harness(
  responses: unknown[] = [{ code: 0, msg: "", data: null }],
  scriptsState: Parameters<typeof scriptsPort>[0] = {},
) {
  const abort = new AbortController();
  const dispose = vi.fn(async () => abort.abort());
  const server: KimiServerManager = {
    run: (operation) => operation(ACCESS, abort.signal),
    dispose,
  };
  // Spied rather than built with vi.fn: a mock's call signature is not
  // generic, and `run` is.
  const run = vi.spyOn(server, "run");
  const queue = [...responses];
  const fetcher = vi.fn(async (input: string) => {
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected Kimi API call");
    return {
      ok: true,
      status: 200,
      url: input,
      json: async () => response,
    };
  });
  const manager = createKimiCompanionManager(
    server,
    COMPANION_DESCRIPTOR,
    scriptsPort(scriptsState),
    fetcher,
  );
  return { manager, server, run, dispose, fetcher, abort };
}

/** The managed copy's files, faked: a map of name → bytes. The shipped
 * side digests the SAME texts, so "current" is the default and a test
 * bends it by bending one side — exactly the two ways reality bends. */
function scriptsPort(state: {
  files?: ReadonlyMap<string, string>;
  listed?: ReadonlySet<string> | null;
  shippedOverrides?: ReadonlyMap<string, string>;
  brokenRead?: string | null;
} = {}) {
  const files =
    state.files ??
    new Map(COMPANION_DESCRIPTOR.scripts.map((s) => [s.file, "wire bytes"]));
  return {
    list: async () =>
      state.listed === undefined ? new Set(files.keys()) : state.listed,
    read: async (file: string) => {
      if (state.brokenRead === file) throw new Error("unreadable");
      const text = files.get(file);
      if (text === undefined) throw new Error(`no such file: ${file}`);
      return text;
    },
    shipped: async () => {
      const digests = new Map<string, string>();
      for (const [name, text] of files) {
        digests.set(name, await sha256Hex(text));
      }
      for (const [name, sha] of state.shippedOverrides ?? new Map()) {
        digests.set(name, sha);
      }
      return digests;
    },
  };
}

describe("Kimi companion manager", () => {
  it("configures and verifies the reporter in one server transaction", async () => {
    const { manager, run, fetcher } = harness([
      { code: 0, msg: "", data: { plugins: [] } },
      {
        code: 0,
        msg: "",
        data: pluginSummary({ enabled: false }),
      },
      { code: 0, msg: "", data: null },
      { code: 0, msg: "", data: { plugins: [pluginSummary()] } },
    ]);

    await expect(manager.configure(SOURCE_DIRECTORY)).resolves.toEqual({
      version: COMPANION_VERSION,
      enabled: true,
      healthy: true,
      owned: true,
      scriptsCurrent: true,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      `${ACCESS.origin}/api/v1/plugins`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      `${ACCESS.origin}/api/v1/plugins`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
        }),
        body: JSON.stringify({ source: SOURCE_DIRECTORY }),
        redirect: "error",
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      `${ACCESS.origin}/api/v1/plugins/${COMPANION_ID}:enable`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("reads a MISSING script file as not current — the refresh heals it", async () => {
    // Absence is a state, not a failure: configure() reinstalls, so the
    // honest answer is the one that triggers the self-heal.
    const files = new Map(
      COMPANION_DESCRIPTOR.scripts.map((s) => [s.file, "wire bytes"]),
    );
    files.delete("kd-status-hook.sh");
    const { manager } = harness(
      [{ code: 0, msg: "", data: { plugins: [pluginSummary()] } }],
      { files },
    );
    await expect(manager.inspect()).resolves.toMatchObject({
      version: COMPANION_VERSION,
      scriptsCurrent: false,
    });
  });

  it("reads a GONE managed directory as not current — a stub of nothing cannot be the wire", async () => {
    // The RPC says the plugin is installed while the managed directory is
    // not there at all. Answering "current" here would seal the lie from
    // the inside; "not current" points the refresh at it, and reinstalling
    // recreates the directory the same as it recreates a missing file.
    const { manager } = harness(
      [{ code: 0, msg: "", data: { plugins: [pluginSummary()] } }],
      { listed: null },
    );
    await expect(manager.inspect()).resolves.toMatchObject({
      version: COMPANION_VERSION,
      scriptsCurrent: false,
    });
  });

  it("reads an UNREADABLE script file as a failed check, not as current", async () => {
    // A file that exists but cannot be read cannot be healed by the
    // refresh it would trigger — answering "not current" would loop that
    // refresh forever. The check refuses, and the controller shows the
    // error instead of silently looping.
    const { manager } = harness(
      [{ code: 0, msg: "", data: { plugins: [pluginSummary()] } }],
      { brokenRead: "kd-status-hook.sh" },
    );
    await expect(manager.inspect()).rejects.toThrow("unreadable");
  });

  it("reports drifted script bytes as not current even at the expected version", async () => {
    // The 1.6.0 lie itself: version matches, bytes do not.
    const { manager } = harness(
      [{ code: 0, msg: "", data: { plugins: [pluginSummary()] } }],
      { shippedOverrides: new Map([["kd-status-hook.sh", "deadbeef"]]) },
    );
    await expect(manager.inspect()).resolves.toMatchObject({
      version: COMPANION_VERSION,
      scriptsCurrent: false,
    });
  });

  it("inspects the actual Kimi installation state", async () => {
    const { manager } = harness([
      { code: 0, msg: "", data: { plugins: [pluginSummary()] } },
    ]);
    await expect(manager.inspect()).resolves.toEqual({
      version: COMPANION_VERSION,
      enabled: true,
      healthy: true,
      owned: true,
      scriptsCurrent: true,
    });
  });

  it("reports an absent companion from Kimi's empty plugin list", async () => {
    const { manager } = harness([{ code: 0, msg: "", data: { plugins: [] } }]);
    await expect(manager.inspect()).resolves.toBeNull();
  });

  it("removes and verifies absence in one server transaction", async () => {
    const { manager, run, fetcher } = harness([
      { code: 0, msg: "", data: { plugins: [pluginSummary()] } },
      { code: 0, msg: "", data: null },
      { code: 0, msg: "", data: { plugins: [] } },
    ]);

    await expect(manager.remove()).resolves.toBeNull();
    expect(run).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      `${ACCESS.origin}/api/v1/plugins/${COMPANION_ID}:remove`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("asks for a Kimi update when the server has no plugin API", async () => {
    // A kimi older than 0.36.1 mounts no /api/v1/plugins: a 404 page, not
    // an envelope.
    const { manager, fetcher } = harness();
    vi.mocked(fetcher).mockResolvedValueOnce({
      ok: false,
      status: 404,
      url: `${ACCESS.origin}/api/v1/plugins`,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(manager.inspect()).rejects.toThrow(
      "Kimi setup API failed (404). Update Kimi Code and try again.",
    );
  });

  it("refuses a success envelope that carries no plugin list", async () => {
    // Shape drift on the server must read as a setup error, not a TypeError.
    for (const data of [null, [], {}]) {
      const { manager } = harness([{ code: 0, msg: "", data }]);
      await expect(manager.inspect()).rejects.toThrow("Kimi returned no plugin list");
    }
  });

  it("surfaces Kimi's API error", async () => {
    const { manager } = harness([
      { code: 0, msg: "", data: { plugins: [pluginSummary()] } },
      { code: 40412, msg: "plugin not found", data: null },
    ]);
    await expect(manager.remove()).rejects.toThrow("plugin not found");
  });

  /** The 1.2.0→1.3.0 lesson: ownership judged on manifest SHAPE (hook
   * counts) disowned every existing install the moment the companion grew
   * hooks — and the collision gate fires before the version gate, so the
   * user got a dead-end "Plugin ID conflict" with configure() and remove()
   * both refusing. An old version of ours is OURS: owned, then outdated. */
  it("owns an older install whose manifest shape has since changed", async () => {
    const oldInstall = pluginSummary({ version: "1.2.0" });
    const { manager } = harness([{ code: 0, msg: "", data: { plugins: [oldInstall] } }]);
    await expect(manager.inspect()).resolves.toMatchObject({
      owned: true,
      version: "1.2.0",
    });
  });

  it("recognizes an id collision and refuses to overwrite or remove it", async () => {
    const collision = pluginSummary({ displayName: "Someone Else's Plugin" });
    const inspected = harness([
      { code: 0, msg: "", data: { plugins: [collision] } },
    ]);
    await expect(inspected.manager.inspect()).resolves.toMatchObject({
      owned: false,
    });

    const configured = harness([
      { code: 0, msg: "", data: { plugins: [collision] } },
    ]);
    await expect(
      configured.manager.configure(SOURCE_DIRECTORY),
    ).rejects.toThrow("A different Kimi plugin");
    expect(configured.fetcher).toHaveBeenCalledOnce();

    const removed = harness([
      { code: 0, msg: "", data: { plugins: [collision] } },
    ]);
    await expect(removed.manager.remove()).rejects.toThrow(
      "A different Kimi plugin",
    );
    expect(removed.fetcher).toHaveBeenCalledOnce();
  });

  it("does not enable an unexpected install response", async () => {
    const { manager, fetcher } = harness([
      { code: 0, msg: "", data: { plugins: [] } },
      {
        code: 0,
        msg: "",
        data: pluginSummary({ id: "different-plugin" }),
      },
    ]);
    await expect(manager.configure(SOURCE_DIRECTORY)).rejects.toThrow(
      "unexpected plugin",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects configure when final verification does not match", async () => {
    const { manager } = harness([
      { code: 0, msg: "", data: { plugins: [] } },
      {
        code: 0,
        msg: "",
        data: pluginSummary({ enabled: false }),
      },
      { code: 0, msg: "", data: null },
      {
        code: 0,
        msg: "",
        data: { plugins: [pluginSummary({ enabled: false })] },
      },
    ]);
    await expect(manager.configure(SOURCE_DIRECTORY)).rejects.toThrow(
      "could not verify",
    );
  });

  it("aborts an in-flight RPC when the server transaction is cancelled", async () => {
    const abort = new AbortController();
    const run: KimiServerManager["run"] = (operation) =>
      operation(ACCESS, abort.signal);
    const fetcher = vi.fn(
      async (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const manager = createKimiCompanionManager(
      { run, dispose: vi.fn(async () => {}) },
      COMPANION_DESCRIPTOR,
      scriptsPort(),
      fetcher,
    );

    const inspection = manager.inspect();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    abort.abort();

    await expect(inspection).rejects.toThrow("cancelled");
  });
});
