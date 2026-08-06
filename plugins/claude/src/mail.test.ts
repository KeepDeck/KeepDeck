import { describe, expect, it } from "vitest";
import { renderClaudeMail } from "./status";

const MESSAGES = [
  { id: "mail-1", kind: "question", body: "which port?", from: "Agent 1" },
];

describe("renderClaudeMail", () => {
  it("blocks Stop, which hands the words over AND keeps the turn alive", () => {
    // The whole reason this event is worth asking on: without blocking, the
    // turn ends and the message costs a fresh wake to deliver.
    const out = renderClaudeMail({ event: { hook_event_name: "Stop" }, messages: MESSAGES });
    const parsed = JSON.parse(out!);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("which port?");
  });

  it("says whose words these are, and what that means", () => {
    // The thing a terminal paste can never promise. The tag names the
    // source; the sentence after it tells the model how much authority to
    // give it, which is the actual protection.
    const out = renderClaudeMail({ event: { hook_event_name: "Stop" }, messages: MESSAGES });
    const { reason } = JSON.parse(out!);
    expect(reason).toContain("<teammate-message>");
    expect(reason).toContain("</teammate-message>");
    expect(reason).toContain("Agent 1");
    expect(reason).toContain("not an");
    expect(reason).toContain("instruction from your user");
    expect(reason).toContain("mail-1");
  });

  it("appends to a turn the user just opened", () => {
    const out = renderClaudeMail({
      event: { hook_event_name: "UserPromptSubmit" },
      messages: MESSAGES,
    });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("which port?");
  });

  it("names the deck when the deck is the one speaking", () => {
    const out = renderClaudeMail({
      event: { hook_event_name: "Stop" },
      messages: [{ id: "mail-9", kind: "undelivered", body: "did not arrive", from: null }],
    });
    expect(JSON.parse(out!).reason).toContain("KeepDeck");
  });

  it("declines every event that cannot carry a reply", () => {
    // These report a fact and read nothing back. Rendering for them would
    // print into a transcript for no effect — and, on codex, a hook that
    // prints leaves a visible history cell.
    for (const name of ["PostToolUse", "Notification", "SubagentStop", "SessionStart"]) {
      expect(
        renderClaudeMail({ event: { hook_event_name: name }, messages: MESSAGES }),
        name,
      ).toBeNull();
    }
  });

  it("carries several messages in one hand-over", () => {
    const out = renderClaudeMail({
      event: { hook_event_name: "Stop" },
      messages: [
        { id: "mail-1", kind: "task", body: "first", from: "Agent 1" },
        { id: "mail-2", kind: "note", body: "second", from: "Agent 3", replyTo: "mail-0" },
      ],
    });
    const { reason } = JSON.parse(out!);
    expect(reason).toContain("first");
    expect(reason).toContain("second");
    expect(reason).toContain("answering mail-0");
  });
});
