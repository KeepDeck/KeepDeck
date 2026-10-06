import { describe, expect, it } from "vitest";
import { decodeBoard, encodeBoard, type TaskBoard } from "../../domain/tasks";
import { board, mintSequence, relation, task } from "../../domain/tasks/testSupport";
import { countsLost, migrateBoards } from "./migration";
import { boardFromStored } from "./storeWire";
import { testDatabase } from "./testDatabase";

const file = (workspace: string, json: string) => ({ workspace, json, checksum: `sum-${json.length}-${workspace}` });
const deps = (workspaces = ["ws-1", "ws-2"]) => ({ workspaces, mintUid: mintSequence("uid-m-") });

/** A board's bytes as the app writes them: through the codec, in its key order. */
function written(b: TaskBoard): string {
  const read = decodeBoard(encodeBoard(b), mintSequence());
  if (!read.ok) throw new Error("does not decode");
  return encodeBoard(read.board);
}

/** A rich board as the app writes it today. */
function current(): TaskBoard {
  return board(
    [
      task({ id: "task-1", assignee: "impl-1", labels: ["ui"], artifacts: ["b", "a"], comments: [{ n: 1, at: 5, from: "lead", body: "go" }], log: [{ at: 6, from: "impl-1", field: "status", was: "todo", now: "in-progress" }] }),
      task({ id: "task-2", status: "done" }),
    ],
    4,
    [relation("blocks", "task-2", "task-1"), relation("copied-from", "task-1", "task-2")],
  );
}

/** What the database holds for `workspace`, as the domain reads it. */
function held(db: ReturnType<typeof testDatabase>, workspace: string): TaskBoard {
  const stored = db.boards().find((b) => b.workspace === workspace)!;
  const read = boardFromStored(stored, mintSequence());
  if (!read.ok) throw new Error(JSON.stringify(read.fault));
  return read.board;
}

describe("migrateBoards — every board at once, nothing lost", () => {
  it("moves every board, reads them back equal, and only then makes the database the source", async () => {
    const one = written(current());
    const two = written(board([task({ id: "task-1", teamId: "team-2" })], 2));
    const db = testDatabase([file("ws-1", one), file("ws-2", two)]);
    const outcome = await migrateBoards(db.port, deps());
    expect(outcome).toEqual({
      kind: "active",
      moved: [
        { workspace: "ws-1", attached: true, adapted: false, dropped: [] },
        { workspace: "ws-2", attached: true, adapted: false, dropped: [] },
      ],
      retireError: null,
    });
    // The files are copies now.
    expect(db.legacy()).toEqual([]);
    expect(db.migration()).toBe("active");
    // Field for field what the files held.
    expect(encodeBoard(held(db, "ws-1"))).toBe(one);
    expect(encodeBoard(held(db, "ws-2"))).toBe(two);
    // The files stopped being the source.
    expect(db.legacy()).toEqual([]);
  });

  it("moves nothing once moved — and finishes making the files left copies", async () => {
    const db = testDatabase([file("ws-1", encodeBoard(current()))]);
    db.refuseNextRetire({ code: "io", detail: "rename refused" });
    // The move stands though the files could not become copies this time.
    expect(await migrateBoards(db.port, deps())).toMatchObject({ kind: "active", retireError: JSON.stringify({ code: "io", detail: "rename refused" }) });
    expect(db.legacy().length).toBe(1);
    expect(await migrateBoards(db.port, deps())).toEqual({ kind: "active", moved: [], retireError: null });
    expect(db.legacy()).toEqual([]);
  });

  it("adapts an old board — before relations and brief versions — into the current shape, every brief kept", async () => {
    const old = JSON.stringify({
      nextId: 3,
      tasks: [
        {
          id: "task-1", teamId: "team-1", title: "T", body: "now", status: "todo", priority: "normal", assignee: null, author: "lead",
          blockedBy: ["task-2"], artifacts: [], labels: ["UI"], comments: [],
          log: [{ at: 1, from: "lead", field: "body", was: "then", now: null }], created: 1, updated: 1,
        },
        {
          id: "task-2", teamId: "team-1", title: "U", body: "", status: "done", priority: "normal", assignee: null, author: "lead",
          blockedBy: [], artifacts: [], comments: [], log: [], created: 1, updated: 1,
        },
      ],
    });
    const db = testDatabase([file("ws-1", old)]);
    const outcome = await migrateBoards(db.port, deps());
    expect(outcome).toMatchObject({ kind: "active", moved: [{ workspace: "ws-1", adapted: true }] });
    const moved = held(db, "ws-1");
    expect(moved.tasks[0]).toMatchObject({ body: "now", bodyV: 2, briefs: [{ v: 1, body: "then" }], labels: ["ui"] });
    expect(moved.tasks[0].log).toEqual([{ at: 1, from: "lead", field: "body", was: "1", now: "2" }]);
    expect(moved.relations.map((r) => r.kind)).toEqual(["blocks"]);
    // No old record left in its old form: the brief text is out of the log.
    expect(JSON.stringify(db.boards())).not.toContain('"was":"then"');
  });

  it("keeps a board whose workspace the deck no longer has — unattached, and says so", async () => {
    const db = testDatabase([file("ws-9", written(current()))]);
    const outcome = await migrateBoards(db.port, deps(["ws-1"]));
    expect(outcome).toEqual({ kind: "active", moved: [{ workspace: "ws-9", attached: false, adapted: false, dropped: [] }], retireError: null });
    expect(db.boards()[0].workspace).toBeNull();
  });

  it("moves nothing when any board does not read — naming the board and why", async () => {
    const db = testDatabase([file("ws-1", encodeBoard(current())), file("ws-2", '{"nextId":1,"tasks":[],"relations":[],"colour":1}')]);
    const outcome = await migrateBoards(db.port, deps());
    expect(outcome).toEqual({ kind: "failed", reason: 'ws-2: board.json: a field this KeepDeck does not know — "colour"' });
    expect(db.migration()).toBe("none");
    expect(db.boards()).toEqual([]);
    expect(db.legacy()).toHaveLength(2);
  });

  it("throws the whole import away when a file changed while it was moved — the files stay the source", async () => {
    const db = testDatabase([file("ws-1", encodeBoard(current()))]);
    db.onImport(() => db.setLegacy([file("ws-1", encodeBoard(current()) + " ")]));
    const outcome = await migrateBoards(db.port, deps());
    expect(outcome.kind).toBe("failed");
    expect(db.migration()).toBe("none");
    expect(db.boards()).toEqual([]);
  });

  it("throws the import away when the activation is refused: the files stay the source", async () => {
    const db = testDatabase([file("ws-1", encodeBoard(current()))]);
    db.refuseNextActivate({ code: "diskFull" });
    const outcome = await migrateBoards(db.port, deps());
    expect(outcome).toEqual({ kind: "failed", reason: `activating the boards in the database: ${JSON.stringify({ code: "diskFull" })}` });
    expect(db.migration()).toBe("none");
    expect(db.boards()).toEqual([]);
    expect(db.legacy().length).toBe(1);
  });

  it("starts over a move cut short between import and activation", async () => {
    const db = testDatabase([file("ws-1", encodeBoard(current()))]);
    await db.port.import([], []);
    expect(db.migration()).toBe("pending");
    const outcome = await migrateBoards(db.port, deps());
    expect(outcome.kind).toBe("active");
    expect(held(db, "ws-1")).toEqual(current());
  });

  it("throws the import away when the database does not give back what was written", async () => {
    const db = testDatabase([file("ws-1", written(current()))]);
    db.tamperImport((boards) => boards.map((b) => ({ ...b, tasks: b.tasks.map((t) => ({ ...t, comments: [] })) })));
    const outcome = await migrateBoards(db.port, deps());
    expect(outcome).toEqual({ kind: "failed", reason: "ws-1: the board read back from the database differs" });
    expect(db.migration()).toBe("none");
  });

  it("counts every task, comment, log entry and brief version of the file through the read", () => {
    const json = written(current());
    const read = decodeBoard(json, mintSequence());
    if (!read.ok) throw new Error("does not decode");
    expect(countsLost(json, read.board, [])).toBeNull();
    const lostComment = { ...read.board, tasks: read.board.tasks.map((t, i) => (i === 0 ? { ...t, comments: [] } : t)) };
    expect(countsLost(json, lostComment, [])).toBe("comments of task-1");
    const lostEntry = { ...read.board, tasks: read.board.tasks.map((t, i) => (i === 0 ? { ...t, log: [] } : t)) };
    expect(countsLost(json, lostEntry, [])).toBe("log entries of task-1");
    const edited = written(board([task({ id: "task-1", bodyV: 2, briefs: [{ v: 1, body: "first" }] })], 2));
    const readEdited = decodeBoard(edited, mintSequence());
    if (!readEdited.ok) throw new Error("does not decode");
    expect(countsLost(edited, readEdited.board, [])).toBeNull();
    const lostBrief = { ...readEdited.board, tasks: readEdited.board.tasks.map((t) => ({ ...t, briefs: [] })) };
    expect(countsLost(edited, lostBrief, [])).toBe("brief versions of task-1");
    expect(countsLost(json, { ...read.board, tasks: read.board.tasks.slice(1) }, [])).toBe("tasks (2 in the file, 1 read)");
  });

  it("moves a first build's brief edit that stored no text — no version invented, every one kept counted", async () => {
    const json = JSON.stringify({
      nextId: 2,
      tasks: [
        {
          id: "task-1", teamId: "team-1", title: "T", body: "third", status: "todo", priority: "normal", assignee: null, author: "lead",
          blockedBy: [], artifacts: [], comments: [], created: 1, updated: 1,
          log: [{ at: 1, from: "lead", field: "body", was: null, now: null }, { at: 2, from: "lead", field: "body", was: "second", now: null }],
        },
      ],
    });
    const read = decodeBoard(json, mintSequence());
    if (!read.ok) throw new Error(JSON.stringify(read.fault));
    expect(countsLost(json, read.board, read.dropped)).toBeNull();
    const db = testDatabase([file("ws-1", json)]);
    expect(await migrateBoards(db.port, deps())).toMatchObject({ kind: "active" });
    expect(held(db, "ws-1").tasks[0]).toMatchObject({ bodyV: 2, briefs: [{ v: 1, body: "second" }] });
  });

  it("holds an old file's blockers to account: each one a link, or named as let go", async () => {
    const json = JSON.stringify({
      nextId: 3,
      tasks: [
        {
          id: "task-1", teamId: "team-1", title: "T", body: "", status: "todo", priority: "normal", assignee: null, author: "lead",
          blockedBy: ["task-2", "task-1", "task-9"], artifacts: [], comments: [], log: [], created: 1, updated: 1,
        },
        {
          id: "task-2", teamId: "team-1", title: "U", body: "", status: "done", priority: "normal", assignee: null, author: "lead",
          blockedBy: [], artifacts: [], comments: [], log: [], created: 1, updated: 1,
        },
      ],
    });
    const read = decodeBoard(json, mintSequence());
    if (!read.ok) throw new Error("does not decode");
    expect(countsLost(json, read.board, read.dropped)).toBeNull();
    // A link let go without being named is a loss.
    expect(countsLost(json, { ...read.board, relations: [] }, read.dropped)).toBe("blockers of task-1");
    expect(countsLost(json, read.board, [])).toBe("blockers of task-1");
    // And the move says which.
    const outcome = await migrateBoards(testDatabase([file("ws-1", json)]).port, deps());
    expect(outcome).toMatchObject({ kind: "active", moved: [{ workspace: "ws-1", dropped: [{ id: "task-1", blockers: ["task-1", "task-9"] }] }] });
  });

  it("does not touch a database it cannot use", async () => {
    const db = testDatabase([file("ws-1", encodeBoard(current()))]);
    db.setStatus({ kind: "damaged", detail: "page 3", backups: [] });
    expect(await migrateBoards(db.port, deps())).toEqual({ kind: "unusable", status: { kind: "damaged", detail: "page 3", backups: [] } });
    expect(db.boards()).toEqual([]);
  });

  it("reads every board on disk exactly as the codec does — the same board, decoded either way", async () => {
    const json = encodeBoard(current());
    const db = testDatabase([file("ws-1", json)]);
    await migrateBoards(db.port, deps());
    const direct = decodeBoard(json, mintSequence());
    expect(direct.ok && held(db, "ws-1")).toEqual(direct.ok && direct.board);
  });
});
