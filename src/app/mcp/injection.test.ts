import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpInjection, KEEPDECK_MCP_SERVER } from "./injection";
import type { McpInjectionTarget } from "./injection";
import type { McpConnection } from "../../ipc/mcp";

const invocation: McpConnection = {
  command: "/Applications/KeepDeck.app/Contents/MacOS/keepdeck",
  args: ["--mcp-shim", "/home/.config/keepdeck/mcp/mcp.sock"],
};

let socket: string | null;

/** A claude pane — the argv path. kimi's file path has its own tests. */
const target: McpInjectionTarget = {
  agentType: "claude",
  cwd: "/repo",
  workspaceId: "ws-1",
  client: "pane-secret",
};

beforeEach(() => {
  socket = "/home/.config/keepdeck/mcp/mcp.sock";
});

describe("the MCP injection", () => {
  it("renders the backend's invocation verbatim — it never rebuilds one", () => {
    // The shim flag and the socket path have one home, on the Rust side. A
    // second derivation here would drift the day either changes.
    const connection = vi.fn(async () => invocation);
    const injection = createMcpInjection({ socket: () => socket, panesIn: () => 1, connection });

    return injection.defs(target).then((defs) => {
      expect(defs).toEqual([
        {
          name: KEEPDECK_MCP_SERVER,
          transport: "stdio",
          command: invocation.command,
          args: invocation.args,
        },
      ]);
    });
  });

  it("injects NOTHING while the transport is not confirmed up", async () => {
    // The gate is the confirmed socket, not the setting: a pane handed a def
    // for a socket that is down spends its startup failing to connect and
    // shows a broken server instead of no server.
    socket = null;
    const connection = vi.fn(async () => invocation);
    const injection = createMcpInjection({ socket: () => socket, panesIn: () => 1, connection });

    expect(await injection.defs(target)).toEqual([]);
    // And it does not even ask the backend how to connect.
    expect(connection).not.toHaveBeenCalled();
  });

  it("injects nothing when the toggle goes Off while the backend answers", async () => {
    // The await is a window: a def minted after the socket went away would be
    // handed to a pane whose server no longer exists.
    let release!: (c: McpConnection) => void;
    const connection = vi.fn(
      () => new Promise<McpConnection>((resolve) => (release = resolve)),
    );
    const injection = createMcpInjection({ socket: () => socket, panesIn: () => 1, connection });

    const pending = injection.defs(target);
    socket = null;
    release(invocation);

    expect(await pending).toEqual([]);
  });

  it("asks for an invocation that NAMES this pane", async () => {
    // The secret is what lets a call be attributed to the pane that made it,
    // and it is the backend that spells the shim's flags — asking without it
    // would hand every pane the same anonymous command.
    const connection = vi.fn(async () => invocation);
    const injection = createMcpInjection({ socket: () => socket, panesIn: () => 1, connection });

    await injection.defs({ ...target, client: "pane-3-secret" });

    expect(connection).toHaveBeenCalledWith("pane-3-secret");
  });

  it("plants a FILE for kimi and tells the hook there is nothing to add", async () => {
    // kimi has no flag and no env: its loader reads <cwd>/.kimi-code/mcp.json,
    // so the delivery happens here and its hook contributes no argv.
    const arm = vi.fn(
      async (_workspaceId: string, entries: { root: string; content: string }[]) => {
        planted.push(...entries);
        return { armed: entries.map((e) => e.root), refused: [] };
      },
    );
    const planted: { root: string; content: string }[] = [];
    const injection = createMcpInjection({
      socket: () => socket,
      panesIn: () => 1,
      connection: async () => invocation,
      arm,
    });

    const defs = await injection.defs({
      agentType: "kimi",
      cwd: "/repo",
      workspaceId: "ws-1",
      client: "pane-secret",
    });

    expect(defs).toEqual([]);
    expect(arm).toHaveBeenCalledWith("ws-1", [
      { root: "/repo", content: expect.any(String) },
    ]);
    const written = JSON.parse(planted[0]!.content);
    expect(written).toEqual({
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
      socket: () => socket,
      panesIn: () => 2,
      connection: named,
      arm: async () => ({ armed: ["/repo"], refused: [] }),
    });

    await injection.defs({
      agentType: "kimi",
      cwd: "/repo",
      workspaceId: "ws-1",
      client: "pane-secret",
    });

    expect(named).toHaveBeenCalledWith(undefined);
  });

  it("keeps the secret for an argv agent even where panes share a directory", async () => {
    // Only the FILE is shared. claude/codex/opencode carry their own argv, so
    // a shared cwd costs them nothing.
    const named = vi.fn(async () => invocation);
    const injection = createMcpInjection({
      socket: () => socket,
      panesIn: () => 3,
      connection: named,
    });

    await injection.defs({ ...target, client: "pane-secret" });

    expect(named).toHaveBeenCalledWith("pane-secret");
  });

  it("takes every planted config back when the transport goes down", async () => {
    // Off means the socket is gone; a config still naming it would point kimi
    // at nothing, and the settings page promises the toggle tears it down.
    const disarm = vi.fn(async (_roots: string[]) => true);
    const injection = createMcpInjection({
      socket: () => socket,
      panesIn: () => 1,
      connection: async () => invocation,
      arm: async (_ws, entries) => ({
        armed: entries.map((e) => e.root),
        refused: [],
      }),
      disarm,
    });
    const kimi = (cwd: string) => ({
      agentType: "kimi",
      cwd,
      workspaceId: "ws-1",
      client: "s",
    });
    await injection.defs(kimi("/a"));
    await injection.defs(kimi("/b"));

    await injection.retract();

    expect(disarm).toHaveBeenCalledWith(["/a", "/b"]);
    // And a second retract has nothing left to say.
    await injection.retract();
    expect(disarm).toHaveBeenCalledTimes(1);
  });

  it("plants nothing for kimi while the transport is down", async () => {
    socket = null;
    const arm = vi.fn(async () => ({ armed: [], refused: [] }));
    const injection = createMcpInjection({
      socket: () => socket,
      panesIn: () => 1,
      connection: async () => invocation,
      arm,
    });

    await injection.defs({
      agentType: "kimi",
      cwd: "/repo",
      workspaceId: "ws-1",
      client: "pane-secret",
    });

    expect(arm).not.toHaveBeenCalled();
  });

  it("leaves the argv agents' servers alone — nothing is planted for them", async () => {
    const arm = vi.fn(async () => ({ armed: [], refused: [] }));
    const injection = createMcpInjection({
      socket: () => socket,
      panesIn: () => 1,
      connection: async () => invocation,
      arm,
    });

    expect(await injection.defs(target)).toHaveLength(1);
    expect(arm).not.toHaveBeenCalled();
  });

  it("does not remember a failure — the next pane may still get served", async () => {
    // Refusing forever because one call failed would need an app restart to
    // recover, for a transport that is otherwise perfectly up.
    const connection = vi
      .fn<() => Promise<McpConnection>>()
      .mockRejectedValueOnce(new Error("no home directory"))
      .mockResolvedValue(invocation);
    const injection = createMcpInjection({ socket: () => socket, panesIn: () => 1, connection });

    expect(await injection.defs(target)).toEqual([]);
    expect((await injection.defs(target)).map((d) => d.name)).toEqual([
      KEEPDECK_MCP_SERVER,
    ]);
  });
});
