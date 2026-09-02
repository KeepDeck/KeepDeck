import { describe, expect, it } from "vitest";
import { tailPass } from "@keepdeck/plugin-api";
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

  it("takes the store claude's own reporter named, and waits when there is none", () => {
    // No project slug to reconstruct and no directory rule: the path was
    // REPORTED. A pane whose agent has not spoken yet simply has nothing to
    // follow, and that is ordinary — the store arrives on a later look.
    expect(claudeTail.follow(target)).toEqual({ path: target.store });
    expect(claudeTail.follow({ ...target, store: null })).toBeNull();
  });
});
