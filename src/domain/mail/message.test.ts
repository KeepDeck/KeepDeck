import { describe, expect, it } from "vitest";
import type { CommandSource } from "../commands";
import { senderOf } from "./message";

describe("senderOf", () => {
  it("names the pane behind an external call", () => {
    const source: CommandSource = {
      kind: "external",
      client: "mcp",
      pane: { id: "pane-1", workspaceId: "ws-1", label: "Agent 1" },
    };
    expect(senderOf(source)).toEqual({
      paneId: "pane-1",
      workspaceId: "ws-1",
      label: "Agent 1",
    });
  });

  it("refuses an anonymous external client", () => {
    // A hand-wired server, or a kimi pane sharing its cwd with another and
    // left anonymous on purpose. There is no pane to send the reply to, so
    // the message would be a dead end the receiver spends a turn finding.
    expect(senderOf({ kind: "external", client: "mcp" })).toBeNull();
  });

  it("refuses the host and plugins — neither can receive an answer", () => {
    expect(senderOf({ kind: "host" })).toBeNull();
    expect(senderOf({ kind: "plugin", pluginId: "voice" })).toBeNull();
  });
});
