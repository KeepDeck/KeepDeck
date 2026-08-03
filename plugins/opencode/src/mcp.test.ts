import { describe, expect, it } from "vitest";
import type { SpawnMcpInput } from "@keepdeck/plugin-api";
import { mcpConfigFragment } from "./mcp";

const server = (name: string): SpawnMcpInput["servers"][number] => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/home/mcp.sock"],
});

describe("the opencode mcp config fragment", () => {
  it("names each server in opencode's own local shape", () => {
    // `command` is program + arguments in ONE array here — opencode's shape,
    // not the {command, args} pair every other CLI takes.
    expect(mcpConfigFragment({ servers: [server("keepdeck")] })).toEqual({
      mcp: {
        keepdeck: {
          type: "local",
          command: ["/bin/keepdeck", "--mcp-shim", "/home/mcp.sock"],
          enabled: true,
        },
      },
    });
  });

  it("carries every server, not just the first", () => {
    const fragment = mcpConfigFragment({
      servers: [server("keepdeck"), server("mnemo")],
    });
    expect(Object.keys(fragment!.mcp)).toEqual(["keepdeck", "mnemo"]);
  });

  it("uses opencode's name for the environment map", () => {
    const fragment = mcpConfigFragment({
      servers: [{ ...server("keepdeck"), env: { KD_PANE: "pane-3" } }],
    });
    expect(fragment!.mcp.keepdeck).toMatchObject({
      environment: { KD_PANE: "pane-3" },
    });
  });

  it("has no fragment at all when there is nothing to inject", () => {
    expect(mcpConfigFragment(undefined)).toBeNull();
    expect(mcpConfigFragment({ servers: [] })).toBeNull();
  });
});
