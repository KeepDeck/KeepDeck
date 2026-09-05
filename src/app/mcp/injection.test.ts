import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpInjection, KEEPDECK_MCP_SERVER } from "./injection";
import type { McpInjectionTarget } from "./injection";
import type { McpConnection } from "../../ipc/mcp";

const invocation: McpConnection = {
  command: "/Applications/KeepDeck.app/Contents/MacOS/keepdeck",
  args: ["--mcp-shim", "/home/.config/keepdeck/mcp/mcp.sock"],
};

let socket: string | null;

/** The ports every construction needs. `plant` is required by design — the
 * guarded form must be the only form — so a test that does not care still
 * has to say what happens when something is planted. */
const ports = {
  panesIn: () => 1,
  plant: async () => ({ armed: [], refused: [] }),
};

/** A claude pane — the argv path. kimi's file path has its own tests. */
const target: McpInjectionTarget = {
  agentType: "claude",
  cwd: "/repo",
  workspaceId: "ws-1",
  client: "pane-secret",
};

const kimi = (cwd: string): McpInjectionTarget => ({
  agentType: "kimi",
  cwd,
  workspaceId: "ws-1",
  client: "pane-secret",
});

beforeEach(() => {
  socket = "/home/.config/keepdeck/mcp/mcp.sock";
});

describe("the MCP injection", () => {
  it("renders the backend's invocation verbatim — it never rebuilds one", async () => {
    // The shim flag and the socket path have one home, on the Rust side. A
    // second derivation here would drift the day either changes.
    const connection = vi.fn(async () => invocation);
    const injection = createMcpInjection({ ...ports, socket: () => socket, connection });

    expect((await injection.access(target)).servers).toEqual([
      {
        name: KEEPDECK_MCP_SERVER,
        transport: "stdio",
        command: invocation.command,
        args: invocation.args,
      },
    ]);
  });

  it("reports where the config landed", async () => {
    // A root's standing refusal goes with the config that now stands there
    // — and only the caller can tell the consumer it happened.
    const onArmed = vi.fn();
    const injection = createMcpInjection({
      ...ports,
      socket: () => socket,
      connection: async () => invocation,
      plant: async () => ({ armed: ["/repo"], refused: [] }),
      onArmed,
    });
    const access = await injection.access(kimi("/repo"));
    await access.deliver();
    expect(onArmed).toHaveBeenCalledWith(["/repo"]);
  });

  it("injects NOTHING while the transport is not confirmed up", async () => {
    // The gate is the confirmed socket, not the setting: a pane handed a def
    // for a socket that is down spends its startup failing to connect and
    // shows a broken server instead of no server.
    socket = null;
    const connection = vi.fn(async () => invocation);
    const injection = createMcpInjection({ ...ports, socket: () => socket, connection });

    expect((await injection.access(target)).servers).toEqual([]);
    // And it does not even ask the backend how to connect.
    expect(connection).not.toHaveBeenCalled();
  });

  it("asks for an invocation that NAMES this pane", async () => {
    // The secret is what lets a call be attributed to the pane that made it,
    // and it is the backend that spells the shim's flags — asking without it
    // would hand every pane the same anonymous command.
    const connection = vi.fn(async () => invocation);
    const injection = createMcpInjection({ ...ports, socket: () => socket, connection });

    await injection.access({ ...target, client: "pane-3-secret" });

    expect(connection).toHaveBeenCalledWith("pane-3-secret");
  });

  it("keeps kimi's servers OFF the argv and out of the plan's way until asked", async () => {
    // kimi has no flag and no env: its loader reads <cwd>/.kimi-code/mcp.json.
    // Answering is a QUESTION and must write nothing — the plan the answer
    // feeds may still be rejected, and a config for a pane that never spawns
    // is a file the user never asked for.
    const plant = vi.fn(async () => ({ armed: ["/repo"], refused: [] }));
    const injection = createMcpInjection({
      ...ports,
      socket: () => socket,
      connection: async () => invocation,
      plant,
    });

    const access = await injection.access(kimi("/repo"));

    expect(access.servers).toEqual([]);
    expect(plant).not.toHaveBeenCalled();
  });

  it("plants a FILE for kimi when the delivery is taken", async () => {
    const planted: { root: string; content: string }[] = [];
    const plant = vi.fn(
      async (_workspaceId: string, root: string, content: string) => {
        planted.push({ root, content });
        return { armed: [root], refused: [] };
      },
    );
    const injection = createMcpInjection({
      ...ports,
      socket: () => socket,
      connection: async () => invocation,
      plant,
    });

    await (await injection.access(kimi("/repo"))).deliver();

    expect(plant).toHaveBeenCalledWith("ws-1", "/repo", expect.any(String));
    expect(JSON.parse(planted[0]!.content)).toEqual({
      mcpServers: {
        keepdeck: { command: invocation.command, args: invocation.args },
      },
    });
  });

  it("plants an ANONYMOUS config when the directory holds more than one pane", async () => {
    // kimi's config is one file per directory. Two panes running there would
    // both announce whichever secret was written last, so the journal would
    // name the wrong pane — worse than naming none.
    const named = vi.fn(async (client?: string) => ({
      command: "/bin/keepdeck",
      args: client ? ["--mcp-shim", "/s", "--client", client] : ["--mcp-shim", "/s"],
    }));
    const injection = createMcpInjection({
      ...ports,
      socket: () => socket,
      panesIn: () => 2,
      connection: named,
    });

    await injection.access(kimi("/repo"));

    expect(named).toHaveBeenCalledWith(undefined);
  });

  it("keeps the secret for an argv agent even where panes share a directory", async () => {
    // Only the FILE is shared. claude/codex/opencode carry their own argv, so
    // a shared cwd costs them nothing.
    const named = vi.fn(async () => invocation);
    const injection = createMcpInjection({
      ...ports,
      socket: () => socket,
      panesIn: () => 3,
      connection: named,
    });

    await injection.access({ ...target, client: "pane-secret" });

    expect(named).toHaveBeenCalledWith("pane-secret");
  });

  it("plants nothing for kimi while the transport is down", async () => {
    socket = null;
    const plant = vi.fn(async () => ({ armed: [], refused: [] }));
    const injection = createMcpInjection({
      ...ports,
      socket: () => socket,
      connection: async () => invocation,
      plant,
    });

    await (await injection.access(kimi("/repo"))).deliver();

    expect(plant).not.toHaveBeenCalled();
  });

  it("leaves the argv agents' servers alone — nothing is planted for them", async () => {
    const plant = vi.fn(async () => ({ armed: [], refused: [] }));
    const injection = createMcpInjection({
      ...ports,
      socket: () => socket,
      connection: async () => invocation,
      plant,
    });

    const access = await injection.access(target);
    await access.deliver();

    expect(access.servers).toHaveLength(1);
    expect(plant).not.toHaveBeenCalled();
  });

  it("does not remember a failure — the next pane may still get served", async () => {
    // Refusing forever because one call failed would need an app restart to
    // recover, for a transport that is otherwise perfectly up.
    const connection = vi
      .fn<() => Promise<McpConnection>>()
      .mockRejectedValueOnce(new Error("no home directory"))
      .mockResolvedValue(invocation);
    const injection = createMcpInjection({ ...ports, socket: () => socket, connection });

    expect((await injection.access(target)).servers).toEqual([]);
    expect((await injection.access(target)).servers.map((d) => d.name)).toEqual([
      KEEPDECK_MCP_SERVER,
    ]);
  });
});
