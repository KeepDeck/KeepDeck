import { describe, expect, it } from "vitest";
import type { ResumeBlock, SessionPickRow } from "../domain/agents";
import { sessionPickItems, sessionPickKey } from "./sessionPickView";

const NOW = 1_000_000;
const row = (sessionId: string, extra: Partial<SessionPickRow["handle"]> = {}): SessionPickRow => ({
  handle: { agent: "claude", sessionId, cwd: "/repo/wt", title: `title ${sessionId}`, ...extra },
  mtime: NOW,
});
const facts = (over: Partial<Parameters<typeof sessionPickItems>[1]> = {}) => ({
  loadingMore: false,
  blockOf: null,
  pickedId: null,
  now: NOW,
  ...over,
});

describe("sessionPickItems — the Start-from picker's list", () => {
  it("lists each session under its row key, named by its title or, failing that, its id", () => {
    const items = sessionPickItems([row("a"), row("b", { title: undefined })], facts());
    expect(items.map(sessionPickKey)).toEqual(["claude:a", "claude:b"]);
    expect(items.map((i) => (i.kind === "session" ? i.name : i.kind))).toEqual(["title a", "b"]);
  });

  it("says where and how old in the meta line, and a held-back resume's reason after it", () => {
    const [plain] = sessionPickItems([row("a")], facts());
    expect(plain.kind === "session" && plain.meta).toMatch(/^wt · /);
    const [noDir] = sessionPickItems([row("a", { cwd: "" })], facts());
    expect(noDir.kind === "session" && noDir.meta).toMatch(/^no directory · /);
    const [gone] = sessionPickItems([row("a")], facts({ blockOf: () => "dir-gone" }));
    expect(gone.kind === "session" && gone.meta).toMatch(/ · directory is gone — fork instead$/);
  });

  it("dims a held-back row, and an outside-held one as busy; offers forks without a gate", () => {
    const blocks: Record<string, ResumeBlock> = { a: null, b: "claimed", c: "busy-outside" };
    const items = sessionPickItems(
      [row("a"), row("b"), row("c")],
      facts({ blockOf: (r) => blocks[r.handle.sessionId] }),
    );
    expect(items.map((i) => i.kind === "session" && [i.blocked, i.busy])).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ]);
    const forks = sessionPickItems([row("b")], facts({ blockOf: null }));
    expect(forks[0].kind === "session" && forks[0].blocked).toBe(false);
  });

  it("draws a seam under every row something follows — the last only while a page loads under it", () => {
    const rows = [row("a"), row("b")];
    const seams = (loadingMore: boolean) =>
      sessionPickItems(rows, facts({ loadingMore })).flatMap((i) => (i.kind === "session" ? [i.seam] : []));
    expect(seams(false)).toEqual([true, false]);
    expect(seams(true)).toEqual([true, true]);
  });

  it("marks the picked row only", () => {
    const items = sessionPickItems([row("a"), row("b")], facts({ pickedId: "b" }));
    expect(items.map((i) => i.kind === "session" && i.active)).toEqual([false, true]);
  });

  it("ends in the loading tail while a page rides, or in the empty line when nothing matched", () => {
    expect(sessionPickItems([row("a")], facts({ loadingMore: true })).map((i) => i.kind)).toEqual([
      "session",
      "more",
    ]);
    expect(sessionPickItems([], facts({ loadingMore: true })).map((i) => i.kind)).toEqual(["more"]);
    expect(sessionPickItems([], facts()).map((i) => i.kind)).toEqual(["empty"]);
    expect(sessionPickItems([], facts({ loadingMore: true }))[0]).toMatchObject({ label: "Loading more sessions" });
    expect(sessionPickItems([], facts())[0]).toMatchObject({ text: "No sessions match" });
    expect(sessionPickItems([row("a")], facts()).map((i) => i.kind)).toEqual(["session"]);
  });
});
