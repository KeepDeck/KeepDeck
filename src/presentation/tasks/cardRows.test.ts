import { describe, expect, it } from "vitest";
import { cardRowEstimate, cardRowKey, cardRows, type CardRow } from "./cardRows";

const comment = (n: number, body = "said") => ({ key: `comment-${n}`, who: "lead", age: "now", body });
const change = (key: string) => ({ kind: "change" as const, key, who: "lead", text: "moved", age: "now" });
const view = (open: boolean) => ({
  comments: [comment(1), comment(2)],
  changes: [change("a"), change("b")],
  activity: { label: "Activity", open },
});

describe("cardRows — the open task as rows of one list", () => {
  it("reads the story, the comments under their heading, then the activity's toggle — its changes only while open", () => {
    expect(cardRows(view(false)).map(cardRowKey)).toEqual(["story", "comments", "comment:comment-1", "comment:comment-2", "activity"]);
    expect(cardRows(view(true)).map(cardRowKey)).toEqual([
      "story",
      "comments",
      "comment:comment-1",
      "comment:comment-2",
      "activity",
      "change:a",
      "change:b",
    ]);
  });

  it("keeps the heading and the toggle with no comments and no changes — they carry the word for none", () => {
    expect(cardRows({ comments: [], changes: [], activity: { label: "Activity", open: true } }).map((r) => r.kind)).toEqual([
      "story",
      "comments",
      "activity",
    ]);
  });

  it("keys a row by what it shows, never its place: a new comment leaves every other key as it was", () => {
    const before = cardRows(view(true)).map(cardRowKey);
    const after = cardRows({ ...view(true), comments: [comment(1), comment(2), comment(3)] }).map(cardRowKey);
    expect(after.filter((key) => key !== "comment:comment-3")).toEqual(before);
    // A comment and a change sharing a key are still two rows.
    expect(new Set([cardRowKey({ kind: "comment", comment: comment(7) }), cardRowKey({ kind: "change", change: change("comment-7") })]).size).toBe(2);
  });

  it("guesses a comment's height by its lines, so a long one is not placed as a short one", () => {
    const short = cardRowEstimate({ kind: "comment", comment: comment(1, "ok") });
    const long = cardRowEstimate({ kind: "comment", comment: comment(1, "x".repeat(560)) });
    const paragraphs = cardRowEstimate({ kind: "comment", comment: comment(1, "a\nb\nc") });
    expect(long).toBeGreaterThan(short * 3);
    expect(paragraphs).toBeGreaterThan(short);
    // A blank line between paragraphs takes a line's room too.
    expect(cardRowEstimate({ kind: "comment", comment: comment(1, "a\n\n\nb") })).toBeGreaterThan(
      cardRowEstimate({ kind: "comment", comment: comment(1, "a\nb") }),
    );
    const kinds: CardRow[] = [{ kind: "story" }, { kind: "comments" }, { kind: "activity" }, { kind: "change", change: change("a") }];
    for (const row of kinds) expect(cardRowEstimate(row)).toBeGreaterThan(0);
  });
});
