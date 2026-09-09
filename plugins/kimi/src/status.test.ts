import { describe, expect, it } from "vitest";
import { normalizeKimiStatus, renderKimiMail } from "./status";

const wrap = (event: Record<string, unknown>) => ({ agent: "kimi", event });

describe("renderKimiMail", () => {
  const render = (hook_event_name: string) =>
    renderKimiMail({
      event: { hook_event_name },
      messages: [
        { id: "mail-3", kind: "task", body: "take the parser", from: "lead" },
      ],
      cliVersion: null,
    });

  it("appends to a prompt through the ONE key kimi reads", () => {
    // kimi's parser takes `message` and `hookSpecificOutput` and nothing
    // else — and it is a loose object, so the claude-shaped answer this
    // used to send validated fine and meant nothing. Not one message ever
    // reached kimi through this channel.
    expect(JSON.parse(render("UserPromptSubmit") ?? "null")).toEqual({
      message: expect.stringContaining("take the parser"),
    });
  });

  it("blocks a turn end the only way kimi's stdout can", () => {
    // A `Stop` result carries text only when it BLOCKS, and stdout can
    // express a block one way: the permission vocabulary reused. For `Stop`
    // it means "do not stop" — kimi appends the reason and keeps going.
    expect(JSON.parse(render("Stop") ?? "null")).toEqual({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("take the parser"),
      },
    });
  });

  it("carries nothing on the events that carry nothing", () => {
    // kimi discards a SessionStart hook's result outright — the trigger is
    // awaited and thrown away — so rendering for it would be writing into
    // a void the deck cannot see.
    for (const name of ["SessionStart", "Interrupt", "PermissionRequest"]) {
      expect(render(name), name).toBeNull();
    }
  });
});

describe("normalizeKimiStatus", () => {
  it("maps the turn boundaries and both permission edges", () => {
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "UserPromptSubmit" }), 100),
    ).toEqual({ kind: "turn-start", at: 100 });
    expect(normalizeKimiStatus(wrap({ hook_event_name: "Stop" }), 200)).toBeNull();
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "PermissionRequest", agent_id: "main" }), 300),
    ).toEqual({ kind: "waiting", at: 300, reason: "permission" });
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "PermissionResult", agent_id: "main" }), 400),
    ).toEqual({ kind: "resumed", at: 400 });
  });

  it.each(["Stop", "Interrupt", "StopFailure"])("does not attribute an ambiguous %s to the main agent", (hook_event_name) => {
    expect(normalizeKimiStatus(wrap({ hook_event_name, session_id: "shared", error_type: "rate_limit" }), 500)).toBeNull();
  });

  it.each(["PermissionRequest", "PermissionResult"])("ignores child and unidentifiable %s", (hook_event_name) => {
    for (const agent_id of [undefined, "agent-1"]) {
      expect(normalizeKimiStatus(wrap({ hook_event_name, agent_id }), 500)).toBeNull();
    }
  });

  it("drops untracked events and garbage", () => {
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "SessionStart" }), 100),
    ).toBeNull();
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "Notification" }), 100),
    ).toBeNull();
    expect(normalizeKimiStatus({ agent: "kimi" }, 100)).toBeNull();
    expect(normalizeKimiStatus(undefined, 100)).toBeNull();
  });
});
