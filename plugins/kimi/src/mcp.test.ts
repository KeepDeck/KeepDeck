import { describe, expect, it } from "vitest";
import type { SpawnMcpInput } from "@keepdeck/plugin-api";
import { mcpConfig, mcpFileDelivery } from "./mcp";

const server = (name: string): SpawnMcpInput["servers"][number] => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/home/mcp.sock"],
});

describe("kimi's MCP file delivery", () => {
  it("declares where its loader actually looks", () => {
    // The host writes the file but never names it: this declaration is the
    // whole reason no host module has to recognise kimi by id.
    expect(mcpFileDelivery.dir).toBe(".kimi-code");
    expect(mcpFileDelivery.name).toBe("mcp.json");
    expect(mcpFileDelivery.render).toBe(mcpConfig);
  });

  it("keys every server by name in the shape kimi's loader reads", () => {
    // The file IS the delivery — kimi takes nothing on argv — so the shape is
    // the whole contract.
    const written = JSON.parse(
      mcpConfig({ servers: [server("keepdeck"), server("mnemo")] }),
    );
    expect(written).toEqual({
      mcpServers: {
        keepdeck: {
          command: "/bin/keepdeck",
          args: ["--mcp-shim", "/home/mcp.sock"],
        },
        mnemo: {
          command: "/bin/keepdeck",
          args: ["--mcp-shim", "/home/mcp.sock"],
        },
      },
    });
  });

  it("carries env only when a server declares it", () => {
    const withEnv = JSON.parse(
      mcpConfig({ servers: [{ ...server("keepdeck"), env: { KD_PANE: "pane-3" } }] }),
    );
    expect(withEnv.mcpServers.keepdeck.env).toEqual({ KD_PANE: "pane-3" });
    const without = JSON.parse(mcpConfig({ servers: [server("keepdeck")] }));
    expect("env" in without.mcpServers.keepdeck).toBe(false);
  });

  it("writes a file, not a fragment — parseable and newline-terminated", () => {
    const text = mcpConfig({ servers: [server("keepdeck")] });
    expect(text.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("has an empty server map when there is nothing to declare", () => {
    // Not "no file": the host only reaches here with an accepted set, and an
    // empty map is still valid config kimi reads as no servers.
    expect(JSON.parse(mcpConfig({ servers: [] }))).toEqual({ mcpServers: {} });
  });
});
