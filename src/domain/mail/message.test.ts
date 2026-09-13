import { describe, expect, it } from "vitest";
import type { CommandSource } from "../commands";
import { senderAddress, senderName, senderOf, type Mail } from "./message";

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

describe("senderAddress", () => {
  const onApi = {
    paneId: "pane-1",
    workspaceId: "ws-1",
    label: "Claude 3",
    role: "impl-1",
    team: { id: "team-1", name: "api" },
  };

  it("answers a teammate with the bare role, which is the only name that is an address", () => {
    expect(senderAddress(onApi, "team-1")).toBe("impl-1");
  });

  it("answers anyone outside the team with role@team — the form that reaches back", () => {
    // Shown the bare role, a receiver on another team answered "lead" and
    // reached its OWN lead. A reader on no team is outside every team.
    expect(senderAddress(onApi, "team-2")).toBe("impl-1@api");
    expect(senderAddress(onApi, null)).toBe("impl-1@api");
  });

  it("keeps a role stamped without its team bare — there is no team to qualify it by", () => {
    expect(
      senderAddress(
        { paneId: "pane-1", workspaceId: "ws-1", label: "Claude 3", role: "impl-1" },
        "team-2",
      ),
    ).toBe("impl-1");
  });

  it("falls back to the title for a sender on no team", () => {
    // Not to `paneId`, though that one always resolves: `pane-N` is a slot a
    // later pane inherits, so a stale id reaches the wrong agent in silence
    // while a stale title comes back as a refusal.
    expect(
      senderAddress({ paneId: "pane-1", workspaceId: "ws-1", label: "Claude 3" }, "team-1"),
    ).toBe("Claude 3");
  });
});

describe("senderName", () => {
  const mail = (from: Mail["from"]): Mail => ({
    id: "mail-1",
    kind: "note",
    body: "hi",
    from,
    toPaneId: "pane-2",
    at: 0,
  });

  it("gives every channel the same answer as senderAddress", () => {
    // Three read paths asked this independently once, and the one that kept
    // its own copy is the one that drifted.
    const sender = {
      paneId: "pane-1",
      workspaceId: "ws-1",
      label: "Claude 3",
      role: "lead",
      team: { id: "team-1", name: "api" },
    };
    for (const reader of ["team-1", "team-2", null]) {
      expect(senderName(mail({ kind: "pane", pane: sender }), reader)).toBe(
        senderAddress(sender, reader),
      );
    }
  });

  it("has no name for the deck itself", () => {
    expect(senderName(mail({ kind: "host" }), "team-1")).toBeNull();
  });
});
