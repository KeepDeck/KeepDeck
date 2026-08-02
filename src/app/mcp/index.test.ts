import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/log", () => ({
  log: { warn: vi.fn() },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { createCommandRegistry, type CommandSource } from "../../domain/commands";
import type { McpRequest } from "../../ipc/mcpBridge";
import { createMcpService, type McpServiceDeps } from ".";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(opts: { initial?: boolean | null } = {}) {
  let value = opts.initial ?? null;
  const listeners = new Set<() => void>();
  const settings = {
    mcpServer: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const set = (next: boolean | null) => {
    value = next;
    for (const listener of [...listeners]) listener();
  };

  let deliver: ((request: McpRequest) => void) | null = null;
  const respond = vi.fn((_id: number, _reply: string) => Promise.resolve());
  const pumpPorts = {
    subscribe(handler: (request: McpRequest) => void) {
      deliver = handler;
      return Promise.resolve(() => {});
    },
    respond,
  };
  const enable = vi.fn(() => Promise.resolve("/home/mcp.sock"));
  const disable = vi.fn(() => Promise.resolve());
  const registry = createCommandRegistry();
  const deps: McpServiceDeps = {
    registry,
    transport: { enable, disable },
    pumpPorts,
    identitySource: () =>
      Promise.resolve({ name: "KeepDeck", version: "9.9.9" }),
    connection: () =>
      Promise.resolve({ command: "/bin/keepdeck", args: ["--mcp-shim", "/s"] }),
  };
  return {
    settings,
    set,
    deps,
    registry,
    enable,
    disable,
    respond,
    request: (id: number, line: string, client: string | null = null) =>
      deliver?.({ id, line, client }),
  };
}

describe("createMcpService", () => {
  it("no enable can be dispatched before the pump's subscription REGISTERS", async () => {
    // Round 2 proved the old ordering pin vacuous (any construction order
    // passed it). This one discriminates: while the subscription promise is
    // held open, the policy must not exist and no enable may fire — even
    // with the setting already On.
    const h = harness({ initial: true });
    let register!: (un: () => void) => void;
    h.deps.pumpPorts = {
      subscribe: () => new Promise((resolve) => (register = resolve)),
      respond: vi.fn((_id: number, _reply: string) => Promise.resolve()),
    };
    createMcpService(h.settings, h.deps);
    await flush();
    expect(h.enable).not.toHaveBeenCalled();
    register(() => {});
    await flush();
    expect(h.enable).toHaveBeenCalledTimes(1);
  });

  it("status reflects what the backend CONFIRMED, not the setting", async () => {
    const h = harness();
    const service = createMcpService(h.settings, h.deps);
    expect(service.status()).toEqual({ socket: null, error: null, refused: [] });

    const seen: string[] = [];
    service.subscribe(() => seen.push(service.status().socket ?? "-"));
    h.set(true);
    await flush();
    expect(service.status()).toEqual({ socket: "/home/mcp.sock", error: null, refused: [] });
    h.set(false);
    await flush();
    expect(service.status()).toEqual({ socket: null, error: null, refused: [] });
    expect(seen).toEqual(["/home/mcp.sock", "-"]);
  });

  it("a refused enable lands in status.error — the UI's signal", async () => {
    const h = harness();
    h.enable.mockRejectedValueOnce(new Error("already served by another process"));
    const service = createMcpService(h.settings, h.deps);
    h.set(true);
    await flush();
    expect(service.status().socket).toBeNull();
    expect(service.status().error).toContain("already served");
  });

  it("a failed disable KEEPS the socket claim — nothing confirmed teardown", async () => {
    const h = harness();
    const service = createMcpService(h.settings, h.deps);
    h.set(true);
    await flush();
    expect(service.status().socket).toBe("/home/mcp.sock");
    h.disable.mockRejectedValueOnce(new Error("ipc failure"));
    h.set(false);
    await flush();
    // Asserting "down" here would hide a socket that is almost certainly
    // still serving — keep the confirmed claim and carry the error.
    expect(service.status().socket).toBe("/home/mcp.sock");
    expect(service.status().error).toContain("ipc failure");
  });

  it("serves registry commands as the external mcp source, journaled", async () => {
    const h = harness();
    let seen: CommandSource | null = null;
    h.registry.register({
      id: "workspace.list",
      title: "List workspaces",
      args: [],
      run: (_args, source) => {
        seen = source;
        return [];
      },
    });
    createMcpService(h.settings, h.deps);
    await flush();
    h.request(
      1,
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"workspace_list"}}',
    );
    await flush();
    expect(seen).toEqual({ kind: "external", client: "mcp" });
    const journal = h.registry.journal();
    expect(journal[journal.length - 1]?.source).toEqual({
      kind: "external",
      client: "mcp",
    });
  });

  it("serves the fetched identity once it lands", async () => {
    const h = harness();
    createMcpService(h.settings, h.deps);
    await flush();
    h.request(2, '{"jsonrpc":"2.0","id":5,"method":"initialize","params":{}}');
    await flush();
    const [, reply] = h.respond.mock.calls[0];
    expect(JSON.parse(reply).result.serverInfo).toEqual({
      name: "KeepDeck",
      version: "9.9.9",
    });
  });

  it("dispose takes the socket down THROUGH the policy's chain", async () => {
    const h = harness();
    const service = createMcpService(h.settings, h.deps);
    await flush(); // pump registered, policy constructed
    service.dispose();
    await flush(); // the final disable rides the chain, one microtask out
    expect(h.disable).toHaveBeenCalled();
  });

  it("a pump that could not register keeps the socket DOWN and says why", async () => {
    // Serving behind a pump nothing can reach costs every client the
    // bridge timeout while the UI advertises a working server.
    const h = harness({ initial: true });
    h.deps.pumpPorts = {
      subscribe: () => Promise.reject(new Error("no event channel")),
      respond: vi.fn((_id: number, _reply: string) => Promise.resolve()),
    };
    const service = createMcpService(h.settings, h.deps);
    await flush();
    expect(h.enable).not.toHaveBeenCalled();
    expect(service.status().socket).toBeNull();
    expect(service.status().error).toContain("cannot receive MCP requests");
  });

  it("dispose is idempotent — extra calls queue no extra teardown", async () => {
    const h = harness();
    const service = createMcpService(h.settings, h.deps);
    await flush();
    service.dispose();
    service.dispose();
    service.dispose();
    await flush();
    expect(h.disable).toHaveBeenCalledTimes(1);
  });

  it("an errorless failure still reads as a problem, not a blank", async () => {
    const h = harness();
    h.enable.mockRejectedValueOnce(new Error(""));
    const service = createMcpService(h.settings, h.deps);
    h.set(true);
    await flush();
    expect(service.status().error).toBe("the transport reported no detail");
  });

  it("dispose before the subscription registers still takes the socket down", async () => {
    const h = harness({ initial: true });
    let register!: (un: () => void) => void;
    h.deps.pumpPorts = {
      subscribe: () => new Promise((resolve) => (register = resolve)),
      respond: vi.fn((_id: number, _reply: string) => Promise.resolve()),
    };
    const service = createMcpService(h.settings, h.deps);
    service.dispose();
    register(() => {});
    await flush();
    // A predecessor page may have left the socket up — best-effort disable;
    // and the disposed guard must keep the policy from ever being built.
    expect(h.disable).toHaveBeenCalled();
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("names the calling pane when its connection proved which one it is", async () => {
    const h = harness({ initial: true });
    h.deps.identify = (client) =>
      client === "pane-3-secret"
        ? { id: "pane-3", workspaceId: "ws-1", label: "Codex 3" }
        : null;
    createMcpService(h.settings, h.deps);
    await flush();
    const sources: CommandSource[] = [];
    h.registry.register({
      id: "deck.ping",
      title: "Ping",
      args: [],
      run: (_args, source) => {
        sources.push(source);
        return null;
      },
    });

    const call = (client: string | null) =>
      h.request(1, JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "deck_ping", arguments: {} },
      }), client);

    call("pane-3-secret");
    call("a-secret-nobody-holds");
    call(null);
    await flush();

    // Known secret: the journal can say WHO. Unknown or absent: anonymous,
    // which is exactly how a server the user wired up by hand has always
    // behaved — and how a lingering child of a dead pane must behave.
    expect(sources).toEqual([
      {
        kind: "external",
        client: "mcp",
        pane: { id: "pane-3", workspaceId: "ws-1", label: "Codex 3" },
      },
      { kind: "external", client: "mcp" },
      { kind: "external", client: "mcp" },
    ]);
  });

  it("reports the folders that kept their own kimi config, and clears them", async () => {
    // Those panes are the only ones silently lacking what every other pane
    // got, so the status carries them to the settings page rather than the
    // log — and a folder that later accepts must stop being reported.
    const h = harness({ initial: true });
    let report = { armed: [] as string[], refused: [{ root: "/repo", reason: "theirs" }] };
    h.deps.arm = async () => report;
    const service = createMcpService(h.settings, h.deps);
    await flush();
    const kimi = { agentType: "kimi", cwd: "/repo", workspaceId: "ws-1", client: "s" };

    await service.defs(kimi);
    expect(service.status().refused).toEqual([{ root: "/repo", reason: "theirs" }]);

    report = { armed: ["/repo"], refused: [] };
    await service.defs(kimi);
    expect(service.status().refused).toEqual([]);
  });

  it("offers a server def only while the transport is CONFIRMED up", async () => {
    // The wiring this pins: the injection reads the SETTLED status through
    // the service, so a pane asking mid-Off gets nothing — the setting alone
    // never decides.
    const h = harness({ initial: true });
    const service = createMcpService(h.settings, h.deps);
    await flush();
    expect((await service.defs({ agentType: "claude", cwd: "/repo", workspaceId: "ws-1", client: "s" })).map((d) => d.name)).toEqual(["keepdeck"]);

    h.set(false);
    await flush();
    expect(await service.defs({ agentType: "claude", cwd: "/repo", workspaceId: "ws-1", client: "s" })).toEqual([]);
  });
});
