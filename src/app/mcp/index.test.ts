import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/log", () => ({
  log: { warn: vi.fn() },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { createCommandRegistry, type CommandSource } from "../../domain/commands";
import type { McpRequest } from "../../ipc/mcpBridge";
import { createMcpService, type McpServiceDeps } from ".";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A pane whose CLI takes no servers on argv and reads a file instead. */
const fileFed = {
  agentType: "kimi",
  cwd: "/repo",
  workspaceId: "ws-1",
  client: "s",
};

function harness() {
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
    panesIn: () => 1,
    plant: async () => ({ armed: [], refused: [] }),
    retract: async () => true,
    identitySource: () =>
      Promise.resolve({ name: "KeepDeck", version: "9.9.9" }),
    connection: vi.fn(() =>
      Promise.resolve({ command: "/bin/keepdeck", args: ["--mcp-shim", "/s"] }),
    ),
  };
  return {
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
    // though the transport is always wanted up.
    const h = harness();
    let register!: (un: () => void) => void;
    h.deps.pumpPorts = {
      subscribe: () => new Promise((resolve) => (register = resolve)),
      respond: vi.fn((_id: number, _reply: string) => Promise.resolve()),
    };
    createMcpService(h.deps);
    await flush();
    expect(h.enable).not.toHaveBeenCalled();
    register(() => {});
    await flush();
    expect(h.enable).toHaveBeenCalledTimes(1);
  });

  it("status reflects what the backend CONFIRMED, once it has", async () => {
    const h = harness();
    const service = createMcpService(h.deps);
    const socketAndError = () => {
      const { socket, error, refused } = service.status();
      return { socket, error, refused };
    };
    // Nothing is assumed before the backend answers.
    expect(socketAndError()).toEqual({ socket: null, error: null, refused: [] });

    const seen: string[] = [];
    service.subscribe(() => seen.push(service.status().socket ?? "-"));
    await flush();
    expect(socketAndError()).toEqual({
      socket: "/home/mcp.sock",
      error: null,
      refused: [],
    });
    // One settled enable, plus the connect lookup that lands under it — the
    // socket it publishes is the same either way.
    expect(seen).toEqual(["/home/mcp.sock", "/home/mcp.sock"]);
  });

  it("looks the connect invocation up itself, anonymously", async () => {
    // It is a fact about the RUNNING transport, not about whichever settings
    // surface happens to be open: a component that fetched it would re-fetch
    // on every mount and hold a copy nothing else could see.
    const h = harness();
    const service = createMcpService(h.deps);
    await flush();
    expect(service.status().connect).toEqual({
      command: "/bin/keepdeck",
      args: ["--mcp-shim", "/s"],
    });
    // Anonymous: there is no pane behind a client the user wires by hand.
    expect(h.deps.connection).toHaveBeenCalledWith();
  });

  it("re-asks for the connect line when the first attempt left none", async () => {
    // It fires once per settled enable, so a request that errored or got
    // lost would stay lost for the page's life — the component used to
    // re-fetch on mount and that self-healing was lost when the lookup moved
    // in here.
    const h = harness();
    const connection = vi
      .fn<() => Promise<{ command: string; args: string[] }>>()
      .mockRejectedValueOnce(new Error("path contains a symlink"))
      .mockResolvedValue({ command: "/bin/keepdeck", args: ["--mcp-shim", "/s"] });
    h.deps.connection = connection;
    const service = createMcpService(h.deps);
    await flush();
    expect(service.status().connect).toBeNull();
    expect(service.status().connectError).toContain("symlink");

    service.refresh();
    await flush();

    expect(service.status().connect).toEqual({
      command: "/bin/keepdeck",
      args: ["--mcp-shim", "/s"],
    });
    expect(service.status().connectError).toBeNull();
  });

  it("retries a refused enable when a settings surface asks", async () => {
    // With no setting to flip there is no event to carry a retry, and a
    // timer would hammer a socket another instance legitimately holds. The
    // user opening a settings surface is what bounds it.
    const h = harness();
    h.enable
      .mockRejectedValueOnce(new Error("already served by another process"))
      .mockResolvedValueOnce("/home/mcp.sock");
    const service = createMcpService(h.deps);
    await flush();
    expect(service.status().socket).toBeNull();
    expect(service.status().error).toContain("already served");

    service.refresh();
    await flush();

    expect(h.enable).toHaveBeenCalledTimes(2);
    expect(service.status().socket).toBe("/home/mcp.sock");
    expect(service.status().error).toBeNull();
    expect(service.status().connect).not.toBeNull();
  });

  it("refresh on a confirmed transport issues no second enable", async () => {
    const h = harness();
    const service = createMcpService(h.deps);
    await flush();
    service.refresh();
    service.refresh();
    await flush();
    expect(h.enable).toHaveBeenCalledTimes(1);
  });

  it("drops a refusal once no pane runs in that folder any more", async () => {
    // Keyed by directory and cleared only by a later successful arming of the
    // SAME directory — so without this it names folders whose pane closed
    // hours ago, and grows for the life of the session.
    const h = harness();
    const live = new Set(["/repo"]);
    h.deps.panesIn = (cwd) => (live.has(cwd) ? 1 : 0);
    h.deps.plant = async (_ws, root) => ({
      armed: [],
      refused: [{ root, reason: "theirs" }],
    });
    const service = createMcpService(h.deps);
    await flush();
    const kimi = (cwd: string) => ({ ...fileFed, cwd });

    await (await service.access(kimi("/repo"))).deliver();
    expect(service.status().refused.map((r) => r.root)).toEqual(["/repo"]);

    live.delete("/repo"); // the pane is closed
    service.refresh();

    expect(service.status().refused).toEqual([]);
  });

  it("keeps a refusal for a pane the deck has not counted yet", async () => {
    // A resume and a fork both plant BEFORE their pane lands, so "no pane runs
    // here" cannot mean the pane went away — and that refusal is the one that
    // matters most: the pane silently has no servers, and this list is the
    // only place saying so. Pruning by the live count alone dropped it the
    // moment the user opened Settings, or any other pane armed anywhere.
    const h = harness();
    h.deps.panesIn = () => 0; // the fork's pane has not landed
    h.deps.plant = async (_ws, root) => ({
      armed: [],
      refused: [{ root, reason: "theirs" }],
    });
    const service = createMcpService(h.deps);
    await flush();

    await (await service.access({ ...fileFed, cwd: "/fork" })).deliver();
    expect(service.status().refused.map((r) => r.root)).toEqual(["/fork"]);

    service.refresh();
    expect(service.status().refused.map((r) => r.root)).toEqual(["/fork"]);

    // Another pane arming elsewhere must not evict it either.
    await (await service.access({ ...fileFed, cwd: "/other" })).deliver();
    expect(service.status().refused.map((r) => r.root)).toEqual([
      "/fork",
      "/other",
    ]);
  });

  it("says nothing more once disposed, even for an enable already in flight", async () => {
    // The callback rides the policy's own chain, so an enable settling after
    // teardown used to publish to listeners a disposed page never dropped and
    // issue fresh IPC during teardown.
    const h = harness();
    let release!: (socket: string) => void;
    h.enable.mockImplementation(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const service = createMcpService(h.deps);
    await flush(); // pump registered, the enable is in flight
    const seen: string[] = [];
    service.subscribe(() => seen.push(service.status().socket ?? "-"));

    service.dispose();
    release("/home/mcp.sock");
    await flush();

    expect(seen).toEqual([]);
    expect(service.status().socket).toBeNull();
  });

  it("reports a failed connect lookup — the server IS still serving", async () => {
    const h = harness();
    h.deps.connection = vi.fn(() =>
      Promise.reject(new Error("path contains a symlink")),
    );
    const service = createMcpService(h.deps);
    await flush();

    expect(service.status().socket).toBe("/home/mcp.sock");
    expect(service.status().connect).toBeNull();
    expect(service.status().connectError).toContain("symlink");
  });

  it("a refused enable lands in status.error — the UI's signal", async () => {
    const h = harness();
    h.enable.mockRejectedValueOnce(new Error("already served by another process"));
    const service = createMcpService(h.deps);
    await flush();
    expect(service.status().socket).toBeNull();
    expect(service.status().error).toContain("already served");
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
    createMcpService(h.deps);
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
    createMcpService(h.deps);
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
    const service = createMcpService(h.deps);
    await flush(); // pump registered, policy constructed
    service.dispose();
    await flush(); // the final disable rides the chain, one microtask out
    expect(h.disable).toHaveBeenCalled();
  });

  it("a pump that could not register keeps the socket DOWN and says why", async () => {
    // Serving behind a pump nothing can reach costs every client the
    // bridge timeout while the UI advertises a working server.
    const h = harness();
    h.deps.pumpPorts = {
      subscribe: () => Promise.reject(new Error("no event channel")),
      respond: vi.fn((_id: number, _reply: string) => Promise.resolve()),
    };
    const service = createMcpService(h.deps);
    await flush();
    expect(h.enable).not.toHaveBeenCalled();
    expect(service.status().socket).toBeNull();
    expect(service.status().error).toContain("cannot receive MCP requests");
    // And a settings surface asking again cannot bring it up either: there
    // is no policy to retry, and the pump is still deaf.
    service.refresh();
    await flush();
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("dispose is idempotent — extra calls queue no extra teardown", async () => {
    const h = harness();
    const service = createMcpService(h.deps);
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
    const service = createMcpService(h.deps);
    await flush();
    expect(service.status().error).toBe("the transport reported no detail");
  });

  it("dispose before the subscription registers still takes the socket down", async () => {
    const h = harness();
    let register!: (un: () => void) => void;
    h.deps.pumpPorts = {
      subscribe: () => new Promise((resolve) => (register = resolve)),
      respond: vi.fn((_id: number, _reply: string) => Promise.resolve()),
    };
    const service = createMcpService(h.deps);
    service.dispose();
    register(() => {});
    await flush();
    // A predecessor page may have left the socket up — best-effort disable;
    // and the disposed guard must keep the policy from ever being built.
    expect(h.disable).toHaveBeenCalled();
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("names the calling pane when its connection proved which one it is", async () => {
    const h = harness();
    h.deps.identify = (client) =>
      client === "pane-3-secret"
        ? { id: "pane-3", workspaceId: "ws-1", label: "Codex 3" }
        : null;
    createMcpService(h.deps);
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
    const h = harness();
    let report = { armed: [] as string[], refused: [{ root: "/repo", reason: "theirs" }] };
    h.deps.plant = async () => report;
    const service = createMcpService(h.deps);
    await flush();
    const kimi = { ...fileFed, cwd: "/repo" };

    await (await service.access(kimi)).deliver();
    expect(service.status().refused).toEqual([{ root: "/repo", reason: "theirs" }]);

    report = { armed: ["/repo"], refused: [] };
    await (await service.access(kimi)).deliver();
    expect(service.status().refused).toEqual([]);
  });

  it("offers a server def only once the transport is CONFIRMED up", async () => {
    // The wiring this pins: the injection reads the SETTLED status through
    // the service, so a pane asking while the enable is refused gets nothing
    // — the transport being wanted up never decides on its own.
    const claude = { agentType: "claude", cwd: "/repo", workspaceId: "ws-1", client: "s" };
    const h = harness();
    h.enable
      .mockRejectedValueOnce(new Error("already served by another process"))
      .mockResolvedValueOnce("/home/mcp.sock");
    const service = createMcpService(h.deps);
    await flush();
    expect((await service.access(claude)).servers).toEqual([]);

    service.refresh(); // the retry lands
    await flush();
    expect((await service.access(claude)).servers.map((d) => d.name)).toEqual([
      "keepdeck",
    ]);
  });
});
