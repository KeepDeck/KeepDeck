import { describe, expect, it } from "vitest";
import { changeSince, changedAt, sinceMark, type TaskLanding } from "./since";
import { task } from "./testSupport";

const comment = (n: number, at: number) => ({ n, at, from: "lead", body: `c${n}` });
const entry = (field: "status" | "body" | "copiedTo", at: number) => ({ at, from: "lead", field, was: null, now: null });

describe("sinceMark", () => {
  it("reads digits as a change number and anything else as an ISO time — or nothing", () => {
    expect(sinceMark("12")).toEqual({ kind: "rev", rev: 12 });
    expect(sinceMark("2026-10-06T10:00:00Z")).toEqual({ kind: "time", at: Date.parse("2026-10-06T10:00:00Z") });
    expect(sinceMark("yesterday-ish")).toBeNull();
  });
});

describe("changeSince — what changed on a task after a mark", () => {
  const t = task({ id: "task-1", created: 100, updated: 100, comments: [comment(1, 110), comment(2, 120)], log: [entry("status", 110), entry("body", 120)] });
  const landing: TaskLanding = { created: 3, rev: 7, comments: [5, 7], log: [5, 7] };

  it("after a rev: exactly what landed after it — the mark itself excluded", () => {
    expect(changeSince(t, { kind: "rev", rev: 2 }, landing)).toEqual({ new: true, comments: 2, fields: ["status", "body"] });
    expect(changeSince(t, { kind: "rev", rev: 5 }, landing)).toEqual({ new: false, comments: 1, fields: ["body"] });
    expect(changeSince(t, { kind: "rev", rev: 7 }, landing)).toBeNull();
    expect(changeSince(t, { kind: "rev", rev: 0 }, undefined)).toBeNull();
  });

  it("from a time: from that moment on, the moment included", () => {
    expect(changeSince(t, { kind: "time", at: 120 }, undefined)).toEqual({ new: false, comments: 1, fields: ["body"] });
    expect(changeSince(t, { kind: "time", at: 100 }, undefined)).toEqual({ new: true, comments: 2, fields: ["status", "body"] });
    expect(changeSince(t, { kind: "time", at: 121 }, undefined)).toBeNull();
  });

  it("counts a change its log holds though its fields did not move — a copy made of it", () => {
    const source = task({ id: "task-2", created: 1000, updated: 1000, log: [entry("copiedTo", 2000)] });
    expect(changedAt(source)).toBe(2000);
    expect(changeSince(source, { kind: "time", at: 1500 }, undefined)).toEqual({ new: false, comments: 0, fields: ["copiedTo"] });
  });
});
