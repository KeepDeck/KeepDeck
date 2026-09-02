import { describe, expect, it } from "vitest";
import { tailPass, watchMatches, watchProject } from "@keepdeck/plugin-api";
import { claudeTail } from "./tail";

const target = { sessionId: "ses_1", store: "/h/p/-repo/ses_1.jsonl", cwd: "/repo" };

describe("claudeTail", () => {
  it("reads the interrupt off the STRUCTURED field, not off the phrase", () => {
    // The whole reason this is keyed on `interruptedMessageId`: an assistant
    // that merely quotes "[Request interrupted…]" must not end its own turn.
    expect(
      claudeTail.read({
        type: "user",
        interruptedMessageId: "msg_1",
        timestamp: "2026-08-14T21:20:29.661Z",
      }),
    ).toEqual({ kind: "interrupted", at: Date.parse("2026-08-14T21:20:29.661Z") });

    expect(
      claudeTail.read({
        type: "assistant",
        timestamp: "2026-08-14T21:20:29.661Z",
      }),
    ).toBeNull();
    expect(
      claudeTail.read({ type: "user", timestamp: "2026-08-14T21:20:29.661Z" }),
    ).toBeNull();
    expect(
      claudeTail.read({
        type: "user",
        interruptedMessageId: "",
        timestamp: "2026-08-14T21:20:29.661Z",
      }),
    ).toBeNull();
  });

  it("refuses to place a marker it cannot date", () => {
    // The staleness guard compares this instant against the turn the marker
    // would end. Stamped with receipt time instead, a marker read a poll
    // interval late outranks the turn it belongs behind and ends one that is
    // still running — so an undatable marker is no marker at all.
    for (const timestamp of [undefined, "", "not a date", 1_700_000_000]) {
      expect(
        claudeTail.read({ type: "user", interruptedMessageId: "m", timestamp }),
        String(timestamp),
      ).toBeNull();
    }
  });

  it("knows the line kinds claude actually writes", () => {
    // Sampled from twelve of the largest transcripts on a real machine.
    // Naming what is skipped is what makes an unnamed kind loud: today an
    // unrecognised line is indistinguishable from an ordinary one, which is
    // how a moved format goes unnoticed until a pane sits on "working".
    const ordinary = [
      "assistant",
      "user",
      "attachment",
      "last-prompt",
      "mode",
      "permission-mode",
      "ai-title",
      "system",
      "queue-operation",
      "file-history-snapshot",
      "file-history-delta",
      "atis-latch",
      "agent-name",
      "bridge-session",
      "frame-link",
      "cost-state",
    ];
    for (const type of ordinary) {
      expect(claudeTail.ignores({ type }), type).toBe(true);
    }
    // And a kind claude has never written is NOT claimed — that is the whole
    // signal.
    expect(claudeTail.ignores({ type: "something-claude-added" })).toBe(false);
    expect(claudeTail.ignores({})).toBe(false);
  });

  it("counts an interrupt among ordinary traffic without claiming the rest", () => {
    const seen: unknown[] = [];
    const pass = tailPass(
      claudeTail,
      [
        { type: "assistant" },
        { type: "queue-operation" },
        { type: "user", interruptedMessageId: "m", timestamp: "2026-08-14T21:20:29.661Z" },
        { type: "user" },
        { type: "a-shape-from-the-future" },
      ],
      (event) => seen.push(event),
    );
    expect(pass).toEqual({ reported: 1, ignored: 3, unknown: 1 });
    expect(seen).toHaveLength(1);
  });

  it("carries out exactly the records it reports on, and nothing else", () => {
    // The invariant behind the descriptor living beside the reader. The two
    // must agree and nothing else would notice them disagreeing: a watch
    // narrower than `read` starves it silently, and one wider pays for
    // records it will throw away — on a claude transcript, the wider mistake
    // is the expensive one, because the records it would carry are the fat
    // ones.
    const lines = [
      { type: "user", interruptedMessageId: "m", timestamp: "2026-08-14T21:20:29.661Z" },
      { type: "user", timestamp: "2026-08-14T21:20:29.661Z" },
      { type: "assistant", message: { content: "everything the model said" } },
      { type: "queue-operation", content: "what the person typed" },
    ];
    for (const line of lines) {
      const carried = watchMatches(claudeTail.watches[0], line);
      const reported = claudeTail.read(line) !== null;
      expect(carried, JSON.stringify(line)).toBe(reported);
    }
  });

  it("leaves the conversation in the transcript", () => {
    // `keep` names no message field, so a message cannot leave through here.
    // Not a rule to remember — the field is never copied.
    const projected = watchProject(claudeTail.watches[0], {
      type: "user",
      interruptedMessageId: "m",
      timestamp: "2026-08-14T21:20:29.661Z",
      message: { content: "the thing the user actually said" },
      cwd: "/home/somebody/private-repo",
      parentUuid: "106fefea",
    });
    expect(projected).toEqual({
      type: "user",
      interruptedMessageId: "m",
      timestamp: "2026-08-14T21:20:29.661Z",
    });
  });

  it("takes the store claude's own reporter named, and waits when there is none", async () => {
    // No project slug to reconstruct and no directory rule: the path was
    // REPORTED. A pane whose agent has not spoken yet simply has nothing to
    // follow, and that is ordinary — the store arrives on a later look.
    await expect(claudeTail.follow(target)).resolves.toEqual({ path: target.store });
    await expect(claudeTail.follow({ ...target, store: null })).resolves.toBeNull();
  });
});
