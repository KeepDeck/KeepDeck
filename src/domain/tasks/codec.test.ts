import { describe, expect, it } from "vitest";
import { decodeBoard, decodeBoardValue, encodeBoard } from "./codec";
import { EMPTY_BOARD } from "./model";
import { issuable } from "./board";
import { blockerIdsOf, copiedFromOf } from "./relations";
import { transition } from "./transition";
import { board, lead, mintSequence, relation, task } from "./testSupport";

const mint = () => mintSequence("uid-minted-");

/** A task as a board written before relations stored it: no uid, its
 * blockers on it. */
const legacyTask = (id: string, over: Record<string, unknown> = {}) => {
  const { uid: _uid, bodyV: _v, briefs: _b, ...stored } = task({ id });
  return { ...stored, blockedBy: [], ...over };
};

const legacy = (tasks: Record<string, unknown>[], nextId = tasks.length + 1) => JSON.stringify({ nextId, tasks });
/** A task as a build before brief versions wrote it: no `bodyV`, no `briefs`. */
const encodedTask = (id: string) => {
  const { bodyV: _v, briefs: _b, ...rest } = task({ id });
  return rest;
};

describe("board codec", () => {
  it("round-trips a board with comments, a log and links, field for field", () => {
    const original = board(
      [
        task({
          id: "task-1",
          status: "review",
          priority: "high",
          assignee: "impl-1",
          blockedBy: ["task-2"],
          artifacts: ["kd-tasks"],
          comments: [{ n: 1, at: 10, from: "lead", body: "go" }],
          log: [{ at: 9, from: "lead", field: "status", was: "todo", now: "in-progress" }],
        }),
        task({ id: "task-2", status: "done" }),
      ],
      7,
      [relation("copied-from", "task-2", "task-1")],
    );
    expect(decodeBoard(encodeBoard(original), mint())).toEqual({ ok: true, board: original, migrated: false, dropped: [] });
    expect(decodeBoard(encodeBoard(EMPTY_BOARD), mint())).toEqual({ ok: true, board: EMPTY_BOARD, migrated: false, dropped: [] });
  });

  it("carries a link of a kind it does not know, and one whose end is not on the board — as read", () => {
    const original = board([task({ id: "task-1" })], 2, [
      relation("relates", "task-1", "task-9"),
      relation("copied-from", "task-1", "task-8"),
    ]);
    const read = decodeBoard(encodeBoard(original), mint());
    expect(read).toEqual({ ok: true, board: original, migrated: false, dropped: [] });
    expect(read.ok && copiedFromOf(read.board.tasks[0], read.board)).toBe("absent");
  });

  it("refuses the whole board when any task does not fit the vocabulary — naming the task and the field", () => {
    const bad = (patch: Record<string, unknown>) =>
      JSON.stringify({ nextId: 2, tasks: [{ ...task({ id: "task-1" }), ...patch }], relations: [] });
    for (const [patch, field] of [
      [{ status: "waiting" }, "status"],
      [{ priority: "urgent" }, "priority"],
      [{ assignee: 3 }, "assignee"],
      [{ uid: undefined }, "uid (a board with relations gives every task one)"],
      [{ uid: "a b" }, "uid"],
      // Blockers are links on a new board: one on a task too is two answers.
      [{ blockedBy: [] }, "blockedBy (blockers are kept in relations)"],
      [{ comments: [{ n: 1 }] }, "comments"],
      [{ log: [{ at: 1, from: "x", field: "colour", was: null, now: null }] }, "log"],
    ] as const) {
      expect(decodeBoard(bad(patch), mint()), field).toEqual({ ok: false, fault: { kind: "bad-task", index: 0, id: "task-1", field } });
    }
    expect(decodeBoard(bad({ id: "pane-1" }), mint())).toEqual({ ok: false, fault: { kind: "bad-task", index: 0, id: null, field: "id" } });
    // A board from before relations keeps the rule it was written under.
    expect(decodeBoard(legacy([legacyTask("task-1", { blockedBy: [1] })]), mint())).toEqual({
      ok: false,
      fault: { kind: "bad-task", index: 0, id: "task-1", field: "blockedBy" },
    });
  });

  it("refuses non-JSON, a non-object, duplicate ids and uids", () => {
    expect(decodeBoard("{", mint())).toMatchObject({ ok: false, fault: { kind: "not-json" } });
    expect(decodeBoard("[]", mint())).toEqual({ ok: false, fault: { kind: "not-object" } });
    expect(decodeBoard('{"nextId":1}', mint())).toEqual({ ok: false, fault: { kind: "tasks-not-array" } });
    const twice = JSON.stringify({ nextId: 3, tasks: [task({ id: "task-1" }), task({ id: "task-1" })], relations: [] });
    expect(decodeBoard(twice, mint())).toEqual({ ok: false, fault: { kind: "duplicate-id", id: "task-1" } });
    const shared = JSON.stringify({ nextId: 3, tasks: [task({ id: "task-1" }), task({ id: "task-2", uid: "uid-task-1" })], relations: [] });
    expect(decodeBoard(shared, mint())).toEqual({ ok: false, fault: { kind: "duplicate-uid", id: "task-2" } });
  });

  it("refuses a counter that would mint a twin, or is not a safe integer", () => {
    const withOne = (nextId: unknown) => JSON.stringify({ nextId, tasks: [task({ id: "task-7" })], relations: [] });
    for (const nextId of [7, 1, 0, -1, 1.5, "8", undefined, 2 ** 53]) {
      expect(decodeBoard(withOne(nextId), mint())).toEqual({ ok: false, fault: { kind: "bad-counter", atLeast: 8 } });
    }
    expect(decodeBoard(withOne(8), mint()).ok).toBe(true);
    expect(decodeBoard(JSON.stringify({ nextId: 0, tasks: [], relations: [] }), mint())).toEqual({
      ok: false,
      fault: { kind: "bad-counter", atLeast: 1 },
    });
  });
});

describe("board codec — links", () => {
  const two = [task({ id: "task-1" }), task({ id: "task-2" })];
  const withLinks = (relations: unknown) => JSON.stringify({ nextId: 3, tasks: two, relations });
  const link = (over: Record<string, unknown> = {}) => ({ ...relation("blocks", "task-1", "task-2"), ...over });

  it("refuses links that are not a list", () => {
    expect(decodeBoard(withLinks({}), mint())).toEqual({ ok: false, fault: { kind: "relations-not-array" } });
  });

  it("refuses a link that does not fit — naming the field and its ends by key", () => {
    for (const [entry, field] of [
      [link({ kind: 3 }), "kind"],
      [link({ kind: "" }), "kind"],
      [link({ from: 1 }), "from"],
      [link({ to: "a b" }), "to"],
      [link({ at: -1 }), "at"],
      [link({ by: 1 }), "by"],
      [link({ to: "uid-task-1" }), "an end linked to itself"],
    ] as const) {
      const read = decodeBoard(withLinks([entry]), mint());
      expect(read, field).toMatchObject({ ok: false, fault: { kind: "bad-relation", index: 0, field } });
    }
    expect(decodeBoard(withLinks(["x"]), mint())).toEqual({
      ok: false,
      fault: { kind: "bad-relation", index: 0, field: "shape", from: null, to: null },
    });
    expect(decodeBoard(withLinks([link(), link()]), mint())).toEqual({
      ok: false,
      fault: { kind: "bad-relation", index: 1, field: "a repeat of another link", from: "task-1", to: "task-2" },
    });
  });

  it("reads a task under an epic; refuses a second epic, an epic under one, or a link to work as if it were one", () => {
    const family = [task({ id: "task-1", kind: "epic" }), task({ id: "task-2" }), task({ id: "task-3", kind: "epic" })];
    const read = (relations: unknown) => decodeBoard(JSON.stringify({ nextId: 4, tasks: family, relations }), mint());
    expect(read([relation("child-of", "task-2", "task-1")]).ok).toBe(true);
    expect(read([relation("child-of", "task-2", "task-1"), relation("child-of", "task-2", "task-3")])).toMatchObject({
      ok: false,
      fault: { kind: "bad-relation", index: 1, field: "a second link where one is the most" },
    });
    expect(read([relation("child-of", "task-3", "task-1")])).toMatchObject({
      ok: false,
      fault: { kind: "bad-relation", field: "from (must be: task)", from: "task-3", to: "task-1" },
    });
    expect(read([relation("child-of", "task-1", "task-2")])).toMatchObject({ ok: false, fault: { field: "from (must be: task)" } });
    const twoTasks = [task({ id: "task-1" }), task({ id: "task-2" })];
    expect(decodeBoard(JSON.stringify({ nextId: 3, tasks: twoTasks, relations: [relation("child-of", "task-2", "task-1")] }), mint())).toMatchObject({
      ok: false,
      fault: { field: "to (must be: epic)" },
    });
    // The shape alone: an end not on the board is no fault, whatever it was.
    expect(read([relation("child-of", "task-2", "task-9")]).ok).toBe(true);
  });

  it("refuses a copy with two sources, and an end not on the board is named as such", () => {
    const sources = [relation("copied-from", "task-1", "task-2"), relation("copied-from", "task-1", "task-9")];
    expect(decodeBoard(withLinks(sources), mint())).toEqual({
      ok: false,
      fault: { kind: "bad-relation", index: 1, field: "a second link where one is the most", from: "task-1", to: null },
    });
  });

  it("keeps links in one order, so saving the same links twice is the same bytes", () => {
    const a = relation("copied-from", "task-2", "task-1");
    const b = relation("blocks", "task-1", "task-2");
    const read = decodeBoard(withLinks([a, b]), mint());
    expect(read.ok && read.board.relations).toEqual([b, a]);
  });
});

describe("board codec — a board written before relations", () => {
  const read = (tasks: Record<string, unknown>[]) => {
    const decoded = decodeBoard(legacy(tasks), mint());
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.fault));
    return decoded;
  };
  const key = (decoded: ReturnType<typeof read>, uid: string) => decoded.board.tasks.find((t) => t.uid === uid)?.id;

  it("is read as migrated, every task given a uid of its own — one it already had is kept", () => {
    const decoded = read([legacyTask("task-1"), legacyTask("task-2", { uid: "kept-uid" }), legacyTask("task-3")]);
    expect(decoded.migrated).toBe(true);
    expect(decoded.board.tasks.map((t) => t.uid)).toEqual(["uid-minted-1", "kept-uid", "uid-minted-2"]);
    expect(decoded.board.relations).toEqual([]);
  });

  it("reads an empty one as empty", () => {
    expect(decodeBoard(legacy([]), mint())).toEqual({ ok: true, board: EMPTY_BOARD, migrated: true, dropped: [] });
  });

  it("turns blockers into links: dated at the waiting task's making, by nobody it can name", () => {
    const decoded = read([legacyTask("task-1", { created: 40 }), legacyTask("task-2", { blockedBy: ["task-1"], created: 50 })]);
    expect(decoded.board.relations).toEqual([{ kind: "blocks", from: "uid-minted-1", to: "uid-minted-2", at: 50, by: null }]);
    expect(blockerIdsOf(decoded.board.tasks[1], decoded.board)).toEqual(["task-1"]);
  });

  it("never refuses what it read before — a repeat folds, a link to itself or to no task goes, and is said", () => {
    const decoded = read([legacyTask("task-1"), legacyTask("task-2", { blockedBy: ["task-1", "task-1", "task-2", "task-9"] })]);
    expect(decoded.board.relations.map((r) => [key(decoded, r.from), key(decoded, r.to)])).toEqual([["task-1", "task-2"]]);
    expect(decoded.dropped).toEqual([{ id: "task-2", blockers: ["task-2", "task-9"] }]);
  });

  it("keeps a cycle and a link across teams — they show, and hold, today", () => {
    // (Held: see the migrated-cycle gate test below.)
    const decoded = read([
      legacyTask("task-1", { blockedBy: ["task-2"] }),
      legacyTask("task-2", { blockedBy: ["task-1"] }),
      legacyTask("task-3", { teamId: "team-2", blockedBy: ["task-1"] }),
    ]);
    const pairs = decoded.board.relations.map((r) => [key(decoded, r.from), key(decoded, r.to)]);
    expect(pairs).toEqual(expect.arrayContaining([["task-2", "task-1"], ["task-1", "task-2"], ["task-1", "task-3"]]));
    expect(pairs).toHaveLength(3);
  });

  const entry = (field: string, now: string, at: number, from = "lead") => ({ at, from, field, was: null, now });

  it("links a copy to its source from either end of the log — the copy's, or the source's alone", () => {
    const fromCopy = read([legacyTask("task-1"), legacyTask("task-2", { log: [entry("copiedFrom", "task-1", 7, "impl-1")] })]);
    expect(fromCopy.board.relations).toEqual([
      { kind: "copied-from", from: "uid-minted-2", to: "uid-minted-1", at: 7, by: "impl-1" },
    ]);
    // The copy's own entry fell off its cap: the source's still says so.
    const fromSource = read([legacyTask("task-1", { log: [entry("copiedTo", "task-2", 7)] }), legacyTask("task-2")]);
    expect(fromSource.board.relations).toEqual([
      { kind: "copied-from", from: "uid-minted-2", to: "uid-minted-1", at: 7, by: "lead" },
    ]);
  });

  it("keeps one source per copy — the latest — and none for a source no longer on the board", () => {
    const decoded = read([
      legacyTask("task-1"),
      legacyTask("task-2"),
      legacyTask("task-3", { log: [entry("copiedFrom", "task-1", 5), entry("copiedFrom", "task-2", 9)] }),
      legacyTask("task-4", { log: [entry("copiedFrom", "task-8", 5)] }),
    ]);
    expect(decoded.board.relations.map((r) => [r.kind, key(decoded, r.from), key(decoded, r.to), r.at])).toEqual([
      ["copied-from", "task-3", "task-2", 9],
    ]);
    // The log keeps what it said either way.
    expect(decoded.board.tasks[3].log).toHaveLength(1);
  });

  it("links nothing for a copy whose log keeps neither end — what survived is all it reads", () => {
    const decoded = read([legacyTask("task-1", { log: [entry("status", "todo", 3)] }), legacyTask("task-2")]);
    expect(decoded.board.relations).toEqual([]);
  });

  it("mints a uid for every task of an old board; on a new one, a task without a uid is refused", () => {
    const old = read([legacyTask("task-1"), legacyTask("task-2")]);
    expect(old.board.tasks.every((t) => t.uid.startsWith("uid-minted-"))).toBe(true);
    const { uid: _uid, ...bare } = task({ id: "task-2" });
    const mixed = JSON.stringify({ nextId: 3, tasks: [task({ id: "task-1" }), bare], relations: [] });
    expect(decodeBoard(mixed, mint())).toEqual({
      ok: false,
      fault: { kind: "bad-task", index: 1, id: "task-2", field: "uid (a board with relations gives every task one)" },
    });
    // On an old board a uid is no rule it was written under: a broken one,
    // or a twin, is drawn afresh rather than refused.
    const odd = read([legacyTask("task-1", { uid: "a b" }), legacyTask("task-2", { uid: "same" }), legacyTask("task-3", { uid: "same" })]);
    expect(odd.board.tasks.map((t) => t.uid)).toEqual(["uid-minted-1", "same", "uid-minted-2"]);
  });

  it("derives the same links each time it is read — only the uids are drawn afresh", () => {
    const bytes = legacy([legacyTask("task-1"), legacyTask("task-2", { blockedBy: ["task-1"] })]);
    const once = decodeBoard(bytes, mintSequence("a-"));
    const again = decodeBoard(bytes, mintSequence("b-"));
    if (!once.ok || !again.ok) throw new Error("refused");
    expect(blockerIdsOf(once.board.tasks[1], once.board)).toEqual(blockerIdsOf(again.board.tasks[1], again.board));
    expect(once.board.tasks[0].uid).not.toBe(again.board.tasks[0].uid);
  });

  it("is written back in the new shape, which reads as not migrated", () => {
    const decoded = read([legacyTask("task-1"), legacyTask("task-2", { blockedBy: ["task-1"] })]);
    const again = decodeBoard(encodeBoard(decoded.board), mint());
    expect(again).toEqual({ ok: true, board: decoded.board, migrated: false, dropped: [] });
  });
});

describe("board codec — a field it does not know", () => {
  it("is refused at every depth — what a reader drops, a writer erases on the next save", () => {
    const one = (patch: Record<string, unknown>) => ({ ...task({ id: "task-1" }), ...patch });
    const read = (value: unknown) => decodeBoardValue(value, mint());
    expect(read({ nextId: 2, tasks: [], relations: [], colour: "red" })).toEqual({ ok: false, fault: { kind: "unknown-field", field: "colour" } });
    const taskFault = (patch: Record<string, unknown>) => {
      const result = read({ nextId: 2, tasks: [one(patch)], relations: [] });
      return !result.ok && result.fault.kind === "bad-task" ? result.fault.field : null;
    };
    expect(taskFault({ colour: "red" })).toBe('unknown field "colour"');
    expect(taskFault({ comments: [{ n: 1, at: 1, from: "lead", body: "x", edited: true }] })).toBe('comments[0]: unknown field "edited"');
    expect(taskFault({ log: [{ at: 1, from: "lead", field: "status", was: null, now: "todo", why: "x" }] })).toBe('log[0]: unknown field "why"');
    const withLink = read({ nextId: 2, tasks: [one({})], relations: [{ ...relation("blocks", "task-1", "task-9"), note: "x" }] });
    expect(!withLink.ok && withLink.fault).toMatchObject({ kind: "bad-relation", field: 'unknown field "note"' });
  });
});

describe("board codec — brief versions", () => {
  it("turns a log written before versions into versions — every old brief kept, the log keeping who and when", () => {
    const old = {
      nextId: 2,
      relations: [],
      tasks: [
        {
          ...encodedTask("task-1"),
          body: "third",
          log: [
            { at: 1, from: "lead", field: "body", was: "first", now: null },
            { at: 2, from: "impl-1", field: "status", was: "todo", now: "in-progress" },
            { at: 3, from: "user", field: "body", was: "second", now: null },
          ],
        },
      ],
    };
    const read = decodeBoard(JSON.stringify(old), mint());
    if (!read.ok) throw new Error(JSON.stringify(read.fault));
    expect(read.migrated).toBe(true);
    const t = read.board.tasks[0];
    expect(t.body).toBe("third");
    expect(t.bodyV).toBe(3);
    expect(t.briefs).toEqual([{ v: 1, body: "first" }, { v: 2, body: "second" }]);
    expect(t.log).toEqual([
      { at: 1, from: "lead", field: "body", was: "1", now: "2" },
      { at: 2, from: "impl-1", field: "status", was: "todo", now: "in-progress" },
      { at: 3, from: "user", field: "body", was: "2", now: "3" },
    ]);
    // Written back, it reads as it is — nothing left to upgrade.
    expect(decodeBoard(encodeBoard(read.board), mint())).toEqual({ ok: true, board: read.board, migrated: false, dropped: [] });
  });

  it("restores every old brief exactly from what it wrote", () => {
    const texts = ["", "a\nmulti-line brief — with ✓ marks", "x".repeat(8192)];
    const log = texts.map((was, i) => ({ at: i, from: "lead", field: "body", was, now: null }));
    const read = decodeBoard(JSON.stringify({ nextId: 2, relations: [], tasks: [{ ...encodedTask("task-1"), log }] }), mint());
    if (!read.ok) throw new Error("refused");
    expect(read.board.tasks[0].briefs.map((b) => b.body)).toEqual(texts);
  });

  it("refuses versions that do not count up to the current one, or carry more than a number and a text", () => {
    const withBriefs = (bodyV: unknown, briefs: unknown) =>
      decodeBoard(JSON.stringify({ nextId: 2, relations: [], tasks: [{ ...encodedTask("task-1"), bodyV, briefs }] }), mint());
    expect(withBriefs(1, []).ok).toBe(true);
    expect(withBriefs(2, [{ v: 1, body: "a" }]).ok).toBe(true);
    for (const [bodyV, briefs] of [
      [0, []],
      [2, []],
      [3, [{ v: 1, body: "a" }, { v: 3, body: "b" }]],
      [2, [{ v: 1, body: "a", at: 5 }]],
      [2, [{ v: 1 }]],
    ] as const) {
      const read = withBriefs(bodyV, briefs);
      expect(!read.ok && read.fault.kind, JSON.stringify([bodyV, briefs])).toBe("bad-task");
    }
  });

  it("refuses versions without their number, or a number without its versions — either reading would let one go", () => {
    const { bodyV: _v, briefs: _b, ...bare } = encodedTask("task-1") as Record<string, unknown>;
    const read = (extra: Record<string, unknown>) =>
      decodeBoard(JSON.stringify({ nextId: 2, relations: [], tasks: [{ ...bare, body: "now", log: [], ...extra }] }), mint());
    expect(read({ briefs: [{ v: 1, body: "earlier brief" }] })).toMatchObject({ ok: false, fault: { kind: "bad-task", id: "task-1" } });
    expect(read({ bodyV: 2 })).toMatchObject({ ok: false, fault: { kind: "bad-task", id: "task-1" } });
    expect(read({}).ok).toBe(true);
  });

  it("keeps a first build's brief edit, which stored no text, as it is — and invents no version for it", () => {
    const unkept = { at: 1, from: "lead", field: "body", was: null, now: null };
    const kept = { at: 2, from: "lead", field: "body", was: "second", now: null };
    const read = decodeBoard(JSON.stringify({ nextId: 2, relations: [], tasks: [{ ...encodedTask("task-1"), log: [unkept, kept] }] }), mint());
    if (!read.ok) throw new Error(JSON.stringify(read.fault));
    const [t] = read.board.tasks;
    expect(t.briefs).toEqual([{ v: 1, body: "second" }]);
    expect(t.bodyV).toBe(2);
    expect(t.log).toEqual([unkept, { ...kept, was: "1", now: "2" }]);
  });

  it("refuses an old brief edit of any other shape — it cannot be told what it held", () => {
    const log = [{ at: 1, from: "lead", field: "body", was: null, now: "later" }];
    const read = decodeBoard(JSON.stringify({ nextId: 2, relations: [], tasks: [{ ...encodedTask("task-1"), log }] }), mint());
    expect(!read.ok && read.fault).toMatchObject({ kind: "bad-task", id: "task-1" });
  });
});

describe("board codec — what a task is", () => {
  const stored = (kind?: unknown) =>
    JSON.stringify({
      nextId: 2,
      tasks: [
        {
          id: "task-1", teamId: "team-1", title: "t", body: "", status: "todo", priority: "normal",
          assignee: null, author: "lead", blockedBy: [], artifacts: [], comments: [], log: [], created: 1, updated: 1,
          ...(kind === undefined ? {} : { kind }),
        },
      ],
    });

  it("reads a board written before epics as work — absence is no fault", () => {
    const read = decodeBoard(stored(), mint());
    expect(read.ok && read.board.tasks[0].kind).toBe("task");
  });

  it("keeps an epic through a round trip, and refuses a kind it does not know", () => {
    const epic = board([task({ id: "task-1", kind: "epic" })]);
    const read = decodeBoard(encodeBoard(epic), mint());
    expect(read.ok && read.board.tasks[0].kind).toBe("epic");
    expect(decodeBoard(stored("story"), mint())).toMatchObject({ ok: false, fault: { kind: "bad-task", field: "kind" } });
    expect(decodeBoard(stored(1), mint())).toMatchObject({ ok: false, fault: { kind: "bad-task", field: "kind" } });
  });

  it("accepts a log entry about a task's epic", () => {
    const json = stored().replace('"log":[]', '"log":[{"at":1,"from":"lead","field":"parent","was":null,"now":"task-9"}]');
    expect(decodeBoard(json, mint()).ok).toBe(true);
  });
});

describe("board codec — labels", () => {
  const stored = (labels?: unknown) =>
    JSON.stringify({
      nextId: 2,
      tasks: [
        {
          id: "task-1", teamId: "team-1", title: "t", body: "", status: "todo", priority: "normal",
          assignee: null, author: "lead", blockedBy: [], artifacts: [],
          ...(labels === undefined ? {} : { labels }),
          comments: [], log: [], created: 1, updated: 1,
        },
      ],
    });

  it("reads a board written before labels as tasks with none — absence is no fault", () => {
    const read = decodeBoard(stored(), mint());
    expect(read.ok && read.board.tasks[0].labels).toEqual([]);
  });

  it("keeps labels through a round trip, and refuses labels that are not a list of words", () => {
    const read = decodeBoard(stored(["design", "ui"]), mint());
    expect(read.ok && read.board.tasks[0].labels).toEqual(["design", "ui"]);
    expect(decodeBoard(stored("ui"), mint())).toMatchObject({ ok: false, fault: { kind: "bad-task", field: "labels" } });
    expect(decodeBoard(stored([1]), mint())).toMatchObject({ ok: false, fault: { kind: "bad-task", field: "labels" } });
  });

  it("reads a hand-edited set the way the board keeps one, and refuses one it could not keep", () => {
    const read = decodeBoard(stored(["UI", "B", "ui"]), mint());
    expect(read.ok && read.board.tasks[0].labels).toEqual(["b", "ui"]);
    // Refused naming what to put right: the label, or the count.
    expect(decodeBoard(stored(["a/b"]), mint())).toMatchObject({ ok: false, fault: { kind: "bad-task", field: 'label "a/b"' } });
    const many = Array.from({ length: 10 }, (_, i) => `l${i}`);
    expect(decodeBoard(stored(many), mint())).toMatchObject({ ok: false, fault: { kind: "bad-task", field: "labels (more than 5)" } });
  });

  it("accepts a log entry about labels", () => {
    const json = stored(["ui"]).replace('"log":[]', '"log":[{"at":1,"from":"lead","field":"labels","was":null,"now":"ui"}]');
    expect(decodeBoard(json, mint()).ok).toBe(true);
  });

  it("reads a copy's two log ends, and still refuses a log field it does not know", () => {
    const withLog = (field: string) =>
      stored(["ui"]).replace('"log":[]', `"log":[{"at":1,"from":"lead","field":"${field}","was":null,"now":"task-2"}]`);
    for (const field of ["copiedFrom", "copiedTo"]) {
      const read = decodeBoard(withLog(field), mint());
      expect(read.ok && read.board.tasks[0].log[0].field, field).toBe(field);
    }
    expect(decodeBoard(withLog("movedTo"), mint())).toMatchObject({ ok: false, fault: { kind: "bad-task", field: "log" } });
  });
});

describe("board codec — a migrated cycle still holds", () => {
  it("leaves both tasks of a cycle on disk unissuable, each start refused naming the other", () => {
    const decoded = decodeBoard(
      legacy([legacyTask("task-1", { blockedBy: ["task-2"] }), legacyTask("task-2", { blockedBy: ["task-1"] })]),
      mint(),
    );
    if (!decoded.ok) throw new Error("refused");
    const [one, two] = decoded.board.tasks;
    expect(issuable(one, decoded.board)).toBe(false);
    expect(issuable(two, decoded.board)).toBe(false);
    const start = (t: typeof one) => transition(t, { kind: "status", to: "in-progress" }, lead, { board: decoded.board, roster: ["lead"], at: 1 });
    expect(start(one)).toEqual({ ok: false, refusal: { kind: "blocked-by-open", blockers: ["task-2"] } });
    expect(start(two)).toEqual({ ok: false, refusal: { kind: "blocked-by-open", blockers: ["task-1"] } });
  });
});
