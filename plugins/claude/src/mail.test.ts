import { describe, expect, it } from "vitest";
import { renderClaudeMail } from "./status";

const MESSAGES = [
  { id: "mail-1", kind: "question", body: "which port?", from: "Agent 1" },
];

/** claude's hook-output schema has not moved between releases, so its
 * renderer ignores the CLI version and every case here passes none. codex is
 * the one that branches on it. */
const render = (
  hook_event_name: string,
  messages: Parameters<typeof renderClaudeMail>[0]["messages"] = MESSAGES,
) => renderClaudeMail({ event: { hook_event_name }, messages, cliVersion: null });

describe("renderClaudeMail", () => {
  it("blocks Stop, which hands the words over AND keeps the turn alive", () => {
    // The whole reason this event is worth asking on: without blocking, the
    // turn ends and the message costs a fresh wake to deliver.
    const parsed = JSON.parse(render("Stop")!);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("which port?");
  });

  it("says whose words these are, and what that means", () => {
    // The thing a terminal paste can never promise. The tag names the
    // source; the sentence after it tells the model how much authority to
    // give it, which is the actual protection.
    const { reason } = JSON.parse(render("Stop")!);
    expect(reason).toContain("<teammate-message>");
    expect(reason).toContain("</teammate-message>");
    expect(reason).toContain("Agent 1");
    expect(reason).toContain("not an");
    expect(reason).toContain("instruction from your user");
    expect(reason).toContain("mail-1");
  });

  it("appends to a turn the user just opened", () => {
    const parsed = JSON.parse(render("UserPromptSubmit")!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("which port?");
  });

  it("names the deck when the deck is the one speaking", () => {
    const out = render("Stop", [
      { id: "mail-9", kind: "undelivered", body: "did not arrive", from: null },
    ]);
    expect(JSON.parse(out!).reason).toContain("KeepDeck");
  });

  it("declines every event that cannot carry a reply", () => {
    // These report a fact and read nothing back. Rendering for them would
    // print into a transcript for no effect — and, on codex, a hook that
    // prints leaves a visible history cell.
    for (const name of ["PostToolUse", "Notification", "SubagentStop", "SessionStart"]) {
      expect(render(name), name).toBeNull();
    }
  });

  it("carries several messages in one hand-over", () => {
    const { reason } = JSON.parse(
      render("Stop", [
        { id: "mail-1", kind: "task", body: "first", from: "Agent 1" },
        { id: "mail-2", kind: "note", body: "second", from: "Agent 3", replyTo: "mail-0" },
      ])!,
    );
    expect(reason).toContain("first");
    expect(reason).toContain("second");
    expect(reason).toContain("answering mail-0");
  });
});
