import { describe, expect, it } from "vitest";
import { admittedNormalizer } from "@keepdeck/plugin-api";
import {
  attributeKimiEvent,
  KIMI_MAIL_CHANNELS,
  normalizeKimiStatus as normalize,
  renderKimiMail,
} from "./status";

const normalizeKimiStatus = (...args: Parameters<typeof normalize>) => {
  const result = normalize(...args);
  if (result?.kind !== "status-reduction") return result;
  expect(result.events.length).toBeLessThanOrEqual(1);
  return result.events[0] ?? null;
};

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

  it("carries nothing on the events that carry nothing", () => {
    // kimi discards a SessionStart hook's result outright — the trigger is
    // awaited and thrown away — so rendering for it would be writing into
    // a void the deck cannot see.
    // Stop among them: it is not a mail channel (see KIMI_MAIL_CHANNELS).
    for (const name of ["SessionStart", "Stop", "Interrupt", "PermissionRequest"]) {
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
    ).toEqual({ kind: "resumed", at: 400, reason: "permission" });
  });

  it.each(["Stop", "Interrupt", "StopFailure"])("does not attribute an ambiguous %s to the main agent", (hook_event_name) => {
    expect(normalizeKimiStatus(wrap({ hook_event_name, session_id: "shared", error_type: "rate_limit" }), 500)).toBeNull();
  });

  it.each(["PermissionRequest", "PermissionResult"])("ignores child and unidentifiable %s", (hook_event_name) => {
    // Through the admission the host runs: the attribution is what says the
    // report is not the main agent's.
    const admitted = admittedNormalizer({ normalize, attribute: attributeKimiEvent });
    for (const agent_id of [undefined, "agent-1"]) {
      expect(admitted(wrap({ hook_event_name, agent_id }), 500)).toBeNull();
    }
    expect(admitted(wrap({ hook_event_name, agent_id: "main" }), 500)).not.toBeNull();
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

describe("attributeKimiEvent", () => {
  it("reads UserPromptSubmit as the main agent's: it runs only for user prompts", () => {
    expect(attributeKimiEvent(wrap({ hook_event_name: "UserPromptSubmit" }))).toEqual({
      event: "UserPromptSubmit", actor: "main", status: true,
    });
  });

  it("names nobody for the hooks that carry no agent identity", () => {
    // Verified live on 2.2.0: Stop fires for a subagent's turn with no agent
    // field at all.
    for (const name of ["Stop", "Interrupt", "StopFailure"]) {
      expect(attributeKimiEvent(wrap({ hook_event_name: name }))).toEqual({
        event: name, actor: "unknown", status: false,
      });
    }
  });

  it("reads the permission pair by its agent_id", () => {
    expect(attributeKimiEvent(wrap({ hook_event_name: "PermissionRequest", agent_id: "main" })))
      .toMatchObject({ actor: "main", status: true });
    expect(attributeKimiEvent(wrap({ hook_event_name: "PermissionRequest", agent_id: "agent-1" })))
      .toMatchObject({ actor: "child", status: false });
  });

  it("names nobody once the reporter reduced the payload", () => {
    expect(attributeKimiEvent({ agent: "kimi", reduced: true, event: { hook_event_name: "UserPromptSubmit" } }))
      .toMatchObject({ actor: "unknown" });
  });
});

describe("KIMI_MAIL_CHANNELS", () => {
  it("is the manifest's own --ask events: UserPromptSubmit alone, none at turn end", () => {
    expect(KIMI_MAIL_CHANNELS).toEqual([{ event: "UserPromptSubmit", atTurnEnd: false }]);
  });
});
