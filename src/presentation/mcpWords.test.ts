import { describe, expect, it } from "vitest";
import { MCP_BUNDLED_NOTICE, bundledMcpStateText, mcpRefusalText, mcpTransportLine } from "./mcpWords";

describe("the transport's line", () => {
  it("is never silent: a problem first, then whether it is up, then whom it serves", () => {
    // With no switch to read, "no row" would mean "no server".
    expect(mcpTransportLine(null, null)).toContain("coming up");
    expect(mcpTransportLine("/s", "ipc failure")).toContain("reported a problem: ipc failure");
    expect(mcpTransportLine(null, "already served")).toContain("reported a problem");
    const up = mcpTransportLine("/s", null);
    expect(up).toContain("Agent panes");
    expect(up).toContain("refused");
  });
});

describe("a shipped server's state", () => {
  it("says it is not up yet, promising no invocation, until it is given to each pane", () => {
    const pending = bundledMcpStateText("pending");
    expect(pending).toContain("not up yet");
    expect(pending).not.toContain("invocation");
    const perPane = bundledMcpStateText("perPane");
    expect(perPane).toContain("each agent pane");
    expect(perPane).toContain("refused");
    expect(MCP_BUNDLED_NOTICE).toContain("Read-only");
  });
});

describe("the page's own refusal", () => {
  it("tells a client its pane has closed", () => {
    expect(mcpRefusalText("pane-gone")).toContain("has closed");
  });
});
