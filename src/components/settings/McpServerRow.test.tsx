// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServerRow } from "./McpServerRow";
import { mcpTransportLine } from "../../presentation/mcpWords";

type Status = { socket: string | null; error: string | null };
const mcpStatus = vi.hoisted(() => ({ current: { socket: null, error: null } as Status }));
vi.mock("../../app/mcp/useMcpStatus", () => ({
  useMcpStatus: () => mcpStatus.current,
}));

describe("McpServerRow", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    mcpStatus.current = { socket: null, error: null };
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = () => act(() => root.render(createElement(McpServerRow)));

  it("offers no command to copy: the server is handed to each pane", () => {
    mcpStatus.current = { socket: "/home/mcp.sock", error: null };
    mount();
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain(mcpTransportLine("/home/mcp.sock", null));
  });

  it("says what the transport is doing, from the confirmed status", () => {
    mount();
    expect(host.textContent).toContain(mcpTransportLine(null, null));
    mcpStatus.current = { socket: null, error: "already served by another process" };
    mount();
    expect(host.textContent).toContain("already served by another process");
  });
});

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
