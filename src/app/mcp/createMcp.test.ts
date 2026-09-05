import { describe, expect, it, vi } from "vitest";
import { composeMcpServerFile } from "../../domain/mcp";
import type { McpStorage } from "../mcpLibrary";
import { createMcp } from "./createMcp";

/** A storage holding one global server, over the fake transport the service
 * tests use: enable answers a socket, so the bundled tier has a name. */
function wired(storage: Partial<McpStorage> = {}) {
  const store: McpStorage = {
    fetch: async () => [
      {
        scope: { kind: "global" },
        name: "fs",
        content: composeMcpServerFile({ transport: "stdio", command: "mcp-fs", args: [], env: {} }),
      },
    ],
    save: async () => {},
    rename: async () => {},
    remove: async () => {},
    forgetWorkspace: vi.fn(async () => {}),
    ...storage,
  };
  const disable = vi.fn(() => Promise.resolve());
  const mcp = createMcp({
    storage: store,
    panesIn: () => 1,
    plant: async () => ({ armed: [], refused: [] }),
    transport: { enable: () => Promise.resolve("/sock"), disable },
    pumpPorts: { subscribe: () => Promise.resolve(() => {}), respond: () => Promise.resolve() },
    identitySource: () => Promise.resolve({ name: "KeepDeck", version: "0" }),
    connection: () => Promise.resolve({ command: "/bin/keepdeck", args: ["--mcp-shim", "/sock"] }),
  });
  return { mcp, store, disable };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the MCP feature behind one door", () => {
  it("reserves in the library exactly the names the service's bundled tier holds", async () => {
    // The root used to name the deck's server itself — a second home for a
    // fact the tier owns, and the one that would drift when a second shipped
    // server arrived.
    const { mcp } = wired();
    const names = mcp.service.bundled().map((server) => server.name);
    expect(names).toEqual(["keepdeck"]);
    await expect(
      mcp.library.create(
        { kind: "global" },
        { name: "keepdeck", body: { transport: "stdio", command: "x", args: [], env: {} } },
      ),
    ).rejects.toThrow(/KeepDeck ships with/);
  });

  it("feeds the service's injection from the library it built", async () => {
    const { mcp } = wired();
    await flush();
    await flush();
    const access = await mcp.service.access({
      agentType: "claude",
      cwd: "/repo",
      workspaceId: "ws-1",
      client: "s",
    });
    expect(access.entries.map(({ spec }) => spec.name)).toEqual(["keepdeck", "fs"]);
    mcp.dispose();
  });

  it("forgets a workspace through the library, and disposes the service", async () => {
    const { mcp, store, disable } = wired();
    await flush();
    await mcp.forgetWorkspace("ws-1");
    expect(store.forgetWorkspace).toHaveBeenCalledWith("ws-1");
    mcp.dispose();
    await flush();
    expect(disable).toHaveBeenCalled();
  });
});
