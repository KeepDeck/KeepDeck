import { describe, expect, it } from "vitest";
import { ASKS_FOR_MAIL, renderClaudeMail } from "./status";

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
  it("hands the words over at Stop AND keeps the turn alive", () => {
    // The whole reason this event is worth asking on: without it the turn
    // ends and the message costs a fresh wake to deliver.
    const parsed = JSON.parse(render("Stop")!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("which port?");
  });

  it("does not file a teammate's words as a hook error", () => {
    // A block would ALSO keep this turn alive — `Stop` is the one event
    // where it does — and that is how mail travelled here at first. It also
    // pushed the message onto claude's error list, which raises "Stop hook
    // error occurred" on the first delivery of every turn. The envelope is
    // what separates the two, so the envelope is what is pinned.
    expect(JSON.parse(render("Stop")!).decision).toBeUndefined();
  });

  it("says whose words these are, and what that means", () => {
    // The thing a terminal paste can never promise. The tag names the
    // source; the sentence after it tells the model how much authority to
    // give it, which is the actual protection.
    const { additionalContext } = JSON.parse(render("Stop")!).hookSpecificOutput;
    expect(additionalContext).toContain("<teammate-message>");
    expect(additionalContext).toContain("</teammate-message>");
    expect(additionalContext).toContain("Agent 1");
    expect(additionalContext).toContain("not an");
    expect(additionalContext).toContain("instruction from your user");
    expect(additionalContext).toContain("mail-1");
  });

  it("reaches a turn that is still running WITHOUT ending it", () => {
    // The mid-turn door, and the point of the whole feature: a person can
    // correct a working agent through mail instead of typing over their own
    // half-written message, because nothing here touches the terminal.
    //
    // The SHAPE is asserted, not merely that something rendered. This event
    // takes the `additionalContext` envelope its neighbours use and NOT the
    // block `Stop` takes: claude words the two as opposites — a blocked
    // `Stop` "continues the conversation", a blocked `PostToolBatch` "stops
    // the agentic loop before the next model call". The block shipped here
    // once, and it ended the very turn the mail was sent to steer.
    const parsed = JSON.parse(render("PostToolBatch")!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolBatch");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("which port?");
    expect(parsed.decision).toBeUndefined();
  });

  it("carries every armed event in the same envelope, under its own name", () => {
    // The invariant both shipped bugs broke, and the reason it is asserted
    // over the whole asking set rather than per event: a fifth event armed
    // later gets this question asked of it for free, which is what nothing
    // did for the two that got it wrong.
    //
    // `decision` is what the two mistakes had in common. It reads like a
    // portable way to hand words to a running model and is not one: on
    // `PostToolBatch` it stops the agentic loop, on `Stop` it files the
    // message as a hook error. Nothing here may use it.
    for (const event of ASKS_FOR_MAIL) {
      const parsed = JSON.parse(render(event)!);
      expect(parsed.hookSpecificOutput?.hookEventName, event).toBe(event);
      expect(parsed.hookSpecificOutput.additionalContext, event).toContain(
        "which port?",
      );
      expect(parsed.decision, event).toBeUndefined();
    }
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
    expect(JSON.parse(out!).hookSpecificOutput.additionalContext).toContain(
      "KeepDeck",
    );
  });

  it("declines every event that cannot carry a reply", () => {
    // These report a fact and read nothing back. Rendering for them would
    // print into a transcript for no effect — and, on codex, a hook that
    // prints leaves a visible history cell.
    for (const name of ["PostToolUse", "Notification", "SubagentStop"]) {
      expect(render(name), name).toBeNull();
    }
  });

  it("carries several messages in one hand-over", () => {
    const { additionalContext } = JSON.parse(
      render("Stop", [
        { id: "mail-1", kind: "task", body: "first", from: "Agent 1" },
        { id: "mail-2", kind: "note", body: "second", from: "Agent 3", replyTo: "mail-0" },
      ])!,
    ).hookSpecificOutput;
    expect(additionalContext).toContain("first");
    expect(additionalContext).toContain("second");
    expect(additionalContext).toContain("answering mail-0");
  });
});

describe("the armed events and the renderer agree", () => {
  it("renders exactly the events that are armed to ask, and nothing else", () => {
    // The invariant behind ASKS_FOR_MAIL living beside the renderer. Armed
    // but unrendered: the reporter waits out its whole window on every fire
    // and the deck takes messages out of the queue only to put them back.
    // Rendered but unarmed: dead code, and that event's mail falls back to a
    // terminal nudge somebody pays a turn for. Neither fails loudly.
    const messages = [
      { id: "mail-1", kind: "task", body: "take the parser", from: "lead" },
    ];
    for (const event of ASKS_FOR_MAIL) {
      expect(
        renderClaudeMail({
          event: { hook_event_name: event },
          messages,
          cliVersion: null,
        }),
        `${event} is armed to ask but renders nothing`,
      ).not.toBeNull();
    }
    // And an event nobody arms cannot carry one either.
    for (const event of ["PostToolUse", "Notification", "SubagentStop"]) {
      expect(
        renderClaudeMail({
          event: { hook_event_name: event },
          messages,
          cliVersion: null,
        }),
        `${event} renders mail but is not armed to ask`,
      ).toBeNull();
    }
  });
});
