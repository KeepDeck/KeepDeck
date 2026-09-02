import { describe, expect, it } from "vitest";
import {
  ASKS_FOR_MAIL,
  normalizeCodexStatus,
  renderCodexMail,
} from "./status";

const wrap = (event: Record<string, unknown>) => ({ agent: "codex", event });

describe("renderCodexMail", () => {
  const messages = [
    { id: "mail-3", kind: "task" as const, body: "take the parser", from: "lead" },
  ];
  const render = (hook_event_name: string, cliVersion: string | null = "0.147.0") =>
    renderCodexMail({ event: { hook_event_name }, messages, cliVersion });

  it("answers a turn end in the shape codex's own wire structs name", () => {
    // These field names are read out of the shipped 0.147 binary
    // (`StopCommandOutputWire`, `BlockDecisionWire`), not out of a doc. The
    // names this file used before — should_block, block_reason,
    // continuation_fragments — appear NOWHERE in that binary, so every
    // answer was rejected and the teammate learnt nothing.
    const answer = JSON.parse(render("Stop") ?? "null");
    expect(answer).toEqual({ decision: "block", reason: expect.any(String) });
    // codex refuses `decision: block` with an empty reason, and the reason
    // IS the delivery — it is what the model reads next.
    expect(answer.reason).toContain("take the parser");
    expect(answer.reason).toContain("lead");
  });

  it("appends to a prompt through hookSpecificOutput, camelCase and named", () => {
    // A bare `additionalContext` at the root does not validate; it has to sit
    // under hookSpecificOutput WITH its hookEventName.
    expect(JSON.parse(render("UserPromptSubmit") ?? "null")).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("take the parser"),
      },
    });
  });

  it("carries nothing on the events that can carry nothing", () => {
    // Printing on these leaves a history cell in codex's transcript for no
    // effect at all.
    expect(render("PermissionRequest")).toBeNull();
  });

  it("reaches a RUNNING turn through PostToolUse", () => {
    // The mid-turn door, and the point of the whole feature: a person can
    // correct a working agent through mail instead of typing over their own
    // half-written message.
    //
    // This event used to be refused here, on the belief that it read nothing
    // back. codex's own generated schema for it allows exactly this pair,
    // and its source calls what comes back "model-facing hook feedback".
    expect(JSON.parse(render("PostToolUse") ?? "null")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining("take the parser"),
      },
    });
  });

  it("speaks the pre-0.147 schema to a pre-0.147 install", () => {
    // The schema belongs to the RELEASE. An install that has not updated
    // still wants the names the current binary no longer has.
    expect(JSON.parse(render("Stop", "0.146.0") ?? "null")).toEqual({
      should_block: true,
      block_reason: expect.any(String),
      continuation_fragments: [{ text: expect.stringContaining("take the parser") }],
    });
    expect(JSON.parse(render("UserPromptSubmit", "0.146.0") ?? "null")).toEqual({
      additional_context: expect.stringContaining("take the parser"),
    });
  });

  it("treats the changeover release itself as new, and an unknown version too", () => {
    // The boundary is inclusive: 0.147.0 IS the release that changed.
    expect(JSON.parse(render("Stop", "0.147.0") ?? "null")).toHaveProperty("decision");
    // A two-component version compares as if the third were zero, so 0.147
    // must not rank below 0.147.0 and fall back to a retired protocol.
    expect(JSON.parse(render("Stop", "0.147") ?? "null")).toHaveProperty("decision");
    expect(JSON.parse(render("Stop", "1.0.0") ?? "null")).toHaveProperty("decision");
    // And no version at all reads as "assume current": a probe can fail for
    // reasons that have nothing to do with the release, and guessing old
    // would break every install that works.
    expect(JSON.parse(render("Stop", null) ?? "null")).toHaveProperty("decision");
    expect(JSON.parse(render("Stop", "not-a-version") ?? "null")).toHaveProperty("decision");
  });
});

describe("normalizeCodexStatus", () => {
  it("maps the turn boundaries and the permission wait", () => {
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "UserPromptSubmit" }), 100),
    ).toEqual({ kind: "turn-start", at: 100 });
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "Stop" }), 200),
    ).toEqual({ kind: "turn-end", at: 200 });
    // The approval-resolution stand-in: an approved tool's completion is
    // the first post-approval hook codex offers.
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "PostToolUse" }), 250),
    ).toEqual({ kind: "resumed", at: 250 });
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "PermissionRequest" }), 300),
    ).toEqual({ kind: "waiting", at: 300, reason: "permission" });
  });

  it("maps every abort marker to interrupted, at its own time", () => {
    expect(
      normalizeCodexStatus(
        {
          agent: "codex",
          kind: "session.interrupt",
          reason: "interrupted",
          sourceAt: "2026-08-01T10:00:00Z",
        },
        400,
      ),
    ).toEqual({ kind: "interrupted", at: Date.parse("2026-08-01T10:00:00Z") });
    // A non-Esc abort did not COMPLETE either — "Done" would announce a
    // finish nobody got; the quiet "Interrupted" is the smaller lie.
    expect(
      normalizeCodexStatus(
        { agent: "codex", kind: "session.interrupt", reason: "budget_exceeded" },
        400,
      ),
    ).toEqual({ kind: "interrupted", at: 400 });
    // No usable source time falls back to receipt.
    expect(
      normalizeCodexStatus(
        { agent: "codex", kind: "session.interrupt", reason: "interrupted" },
        400,
      ),
    ).toEqual({ kind: "interrupted", at: 400 });
  });

  it("drops untracked events and garbage", () => {
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "SessionStart" }), 100),
    ).toBeNull();
    expect(normalizeCodexStatus({ agent: "codex" }, 100)).toBeNull();
    expect(normalizeCodexStatus(42, 100)).toBeNull();
  });
});

describe("the armed events and the renderer agree", () => {
  it("renders exactly the events that are armed to ask, and nothing else", () => {
    // Same invariant as claude's, and codex names the hazard itself: a drift
    // between the arming and the rendering is silent. Armed but unrendered
    // costs the hook's whole wait on every fire; rendered but unarmed sends
    // that event's mail through a terminal nudge nobody meant to pay for.
    const messages = [
      { id: "mail-1", kind: "task", body: "take the parser", from: "lead" },
    ];
    for (const event of ASKS_FOR_MAIL) {
      expect(
        renderCodexMail({
          event: { hook_event_name: event },
          messages,
          cliVersion: "0.147.0",
        }),
        `${event} is armed to ask but renders nothing`,
      ).not.toBeNull();
    }
    for (const event of ["PermissionRequest"]) {
      expect(
        renderCodexMail({
          event: { hook_event_name: event },
          messages,
          cliVersion: "0.147.0",
        }),
        `${event} renders mail but is not armed to ask`,
      ).toBeNull();
    }
    // The RETIRED schema carries the mid-turn event no further than the
    // boundary ones it already knew: whether it could was never measured,
    // and inventing a shape there is refused wholesale by codex and printed
    // into the pane. An install that old keeps its mail for a turn boundary.
    expect(
      renderCodexMail({
        event: { hook_event_name: "PostToolUse" },
        messages,
        cliVersion: "0.146.0",
      }),
    ).toBeNull();
  });
});
