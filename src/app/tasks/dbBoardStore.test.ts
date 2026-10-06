import { describe, expect, it } from "vitest";
import { encodeBoard, transition, type TaskBoard } from "../../domain/tasks";
import { board, lead, mintSequence, task } from "../../domain/tasks/testSupport";
import { createDbBoardStore } from "./dbBoardStore";
import { testDatabase, isTestStoreError } from "./testDatabase";

const file = (workspace: string, json: string) => ({ workspace, json, checksum: `sum-${workspace}-${json.length}` });

async function open(files = [file("ws-1", encodeBoard(board([task({ id: "task-1", assignee: "lead" })], 2)))]) {
  const db = testDatabase(files);
  const store = createDbBoardStore({ db: db.port, workspaces: () => ["ws-1", "ws-2"], mintUid: mintSequence("uid-s-"), isStoreError: isTestStoreError });
  await store.enable();
  return { db, store };
}

async function readBoard(store: Awaited<ReturnType<typeof open>>["store"], workspaceId = "ws-1"): Promise<TaskBoard> {
  const read = await store.read({ workspaceId });
  if (read.kind !== "board") throw new Error(read.kind);
  return read.board;
}

const comment = (b: TaskBoard, body: string, id = "task-1"): TaskBoard => {
  const t = b.tasks.find((x) => x.id === id)!;
  const result = transition(t, { kind: "comment", body }, lead, { board: b, roster: ["lead"], at: 7 });
  if (!result.ok) throw new Error("refused");
  return result.board;
};

describe("createDbBoardStore — the board reaches the database", () => {
  it("moves the files in at enable, then reads and writes the database", async () => {
    const { db, store } = await open();
    expect(store.writeRefusal()).toBeNull();
    const b = await readBoard(store);
    await store.write({ workspaceId: "ws-1", board: comment(b, "hello") });
    expect(db.boards()[0].tasks[0].comments.map((c) => c.body)).toEqual(["hello"]);
    expect(db.boards()[0].rev).toBe(1);
  });

  it("sends only the change, against what the database confirmed", async () => {
    const { db, store } = await open();
    const b = await readBoard(store);
    const once = comment(b, "one");
    await store.write({ workspaceId: "ws-1", board: once });
    await store.write({ workspaceId: "ws-1", board: comment(once, "two") });
    expect(db.requests.map((r) => r.boards[0].tasks[0].comments.map((c) => c.body))).toEqual([["one"], ["two"]]);
    expect(db.requests[1].boards[0].expectedRev).toBe(1);
  });

  it("knows when each part of a task landed: as the database read it, then as each write lands", async () => {
    const { store } = await open();
    const b = await readBoard(store);
    const uid = b.tasks[0].uid;
    // Moved in from the files: before every change.
    expect(store.revisions("ws-1")?.tasks.get(uid)).toEqual({ created: 0, rev: 0, comments: [], log: [] });
    const once = comment(b, "one");
    await store.write({ workspaceId: "ws-1", board: once });
    const twice = comment(once, "two");
    await store.write({ workspaceId: "ws-1", board: twice });
    expect(store.revisions("ws-1")?.tasks.get(uid)).toEqual({ created: 0, rev: 2, comments: [1, 2], log: [] });
    const made = { ...twice, tasks: [...twice.tasks, { ...b.tasks[0], uid: "uid-new", id: "task-9", comments: [] }], nextId: 10 };
    await store.write({ workspaceId: "ws-1", board: made });
    expect(store.revisions("ws-1")?.tasks.get("uid-new")?.created).toBe(3);
  });

  it("carries a refused write's change in the next one", async () => {
    const { db, store } = await open();
    const b = await readBoard(store);
    const afterB = comment(b, "B");
    db.refuseNextApply({ code: "busy" });
    await expect(store.write({ workspaceId: "ws-1", board: afterB })).rejects.toThrow("another program");
    await store.write({ workspaceId: "ws-1", board: comment(afterB, "C") });
    expect(db.boards()[0].tasks[0].comments.map((c) => c.body)).toEqual(["B", "C"]);
  });

  it("sends a request whose answer was lost again — the same request, applied once — before the next", async () => {
    const { db, store } = await open();
    const b = await readBoard(store);
    const afterB = comment(b, "B");
    db.loseNextAnswer();
    await expect(store.write({ workspaceId: "ws-1", board: afterB })).rejects.toThrow("lost");
    // B landed; its answer did not. C must not be taken for B's repeat, nor B applied twice.
    await store.write({ workspaceId: "ws-1", board: comment(afterB, "C") });
    expect(db.requests[1].requestId).toBe(db.requests[0].requestId);
    expect(db.boards()[0].tasks[0].comments.map((c) => c.body)).toEqual(["B", "C"]);
    expect(db.boards()[0].rev).toBe(2);
  });

  it("reads the board again after a conflict, so the next write is computed against what is there", async () => {
    const { db, store } = await open();
    const b = await readBoard(store);
    // Someone else moved the board on.
    db.boards()[0].rev = 5;
    await expect(store.write({ workspaceId: "ws-1", board: comment(b, "x") })).rejects.toThrow("changed in the database");
    await store.write({ workspaceId: "ws-1", board: comment(b, "x") });
    expect(db.requests[db.requests.length - 1].boards[0].expectedRev).toBe(5);
  });

  it("writes the board over what the database holds once, after a constraint — and says so only if that is refused too", async () => {
    const { db, store } = await open();
    const b = await readBoard(store);
    db.refuseNextApply({ code: "constraint", detail: "comment 1 is stored with other content" });
    await store.write({ workspaceId: "ws-1", board: comment(b, "x") });
    expect(db.boards()[0].tasks[0].comments.map((c) => c.body)).toEqual(["x"]);
    // Two requests: the refused one, then the change from what was read back.
    expect(db.requests.length).toBe(2);
    expect(db.requests[1].requestId).not.toBe(db.requests[0].requestId);
    const again = comment(comment(b, "x"), "y");
    db.refuseNextApply({ code: "constraint", detail: "still" });
    db.refuseNextApply({ code: "constraint", detail: "still" });
    await expect(store.write({ workspaceId: "ws-1", board: again })).rejects.toThrow("does not fit the stored board: still");
    expect(db.requests.length).toBe(4);
  });

  it("gives a workspace's first board an id of its own", async () => {
    const { db, store } = await open();
    expect(await store.read({ workspaceId: "ws-2" })).toEqual({ kind: "none" });
    await store.write({ workspaceId: "ws-2", board: board([task({ id: "task-1", teamId: "team-2" })], 2) });
    const made = db.boards().find((x) => x.workspace === "ws-2")!;
    expect(made.board).not.toBe("ws-2");
    expect(made.tasks[0].key).toBe("task-1");
  });

  it("writes nothing once the database is found damaged, and says why", async () => {
    const { db, store } = await open();
    const b = await readBoard(store);
    db.refuseNextApply({ code: "corrupt", detail: "page 3" });
    await expect(store.write({ workspaceId: "ws-1", board: comment(b, "x") })).rejects.toThrow("damaged");
    expect(store.writeRefusal()).toBe("the task database is damaged: page 3");
    await expect(store.write({ workspaceId: "ws-1", board: comment(b, "y") })).rejects.toThrow("damaged");
  });

  it("writes nothing once a newer build is found to own the database — and offers no restore over it", async () => {
    const { db, store } = await open();
    const b = await readBoard(store);
    db.refuseNextApply({ code: "schemaTooNew", migration: "2099" });
    await expect(store.write({ workspaceId: "ws-1", board: comment(b, "x") })).rejects.toThrow("newer KeepDeck");
    expect(store.writeRefusal()).toBe("a newer KeepDeck wrote the task database (2099) — this one neither reads nor writes it");
    expect(store.recovery()).toBeNull();
  });

  it("learns damage from whichever call meets it — a read as well as a write", async () => {
    const { db, store } = await open();
    const held = await readBoard(store);
    db.setStatus({ kind: "damaged", detail: "page 3", backups: [100] });
    db.refuseNextLoad({ code: "corrupt", detail: "page 3" });
    await expect(store.read({ workspaceId: "ws-2" })).rejects.toMatchObject({ code: "corrupt" });
    expect(store.writeRefusal()).toBe("the task database is damaged: page 3");
    expect(store.recovery()).toEqual({ kind: "damaged", backups: [100] });
    // The board already held is not written either.
    await expect(store.write({ workspaceId: "ws-1", board: comment(held, "x") })).rejects.toThrow("damaged");
  });

  it("restores a damaged database from a backup, and the board held in memory is written over it — nothing of either lost", async () => {
    const { db, store } = await open();
    const b = await readBoard(store);
    await store.write({ workspaceId: "ws-1", board: comment(b, "in the backup") });
    db.takeBackup(100);
    // Saved after the backup — then the database is found damaged.
    const one = comment(comment(b, "in the backup"), "saved after the backup");
    await store.write({ workspaceId: "ws-1", board: one });
    const two = comment(one, "only in memory");
    db.setStatus({ kind: "damaged", detail: "page 3", backups: [100] });
    db.refuseNextApply({ code: "corrupt", detail: "page 3" });
    await expect(store.write({ workspaceId: "ws-1", board: two })).rejects.toThrow("damaged");
    expect(store.recovery()).toEqual({ kind: "damaged", backups: [100] });
    await store.restore({ kind: "backup", at: 100 });
    expect(store.writeRefusal()).toBeNull();
    expect(store.recovery()).toBeNull();
    // The memory's board, newer than the backup, is written over it as a change.
    await store.write({ workspaceId: "ws-1", board: two });
    // Read afresh from the restored database, so nothing the backup lacks is skipped.
    expect(db.boards()[0].tasks[0].comments.map((c) => c.body)).toEqual(["in the backup", "saved after the backup", "only in memory"]);
  });

  it("a missing database is the person's to recover: nothing written until they start it empty", async () => {
    const db = testDatabase();
    db.setStatus({ kind: "missing", detail: "a copy of it set aside is still there", backups: [] });
    const store = createDbBoardStore({ db: db.port, workspaces: () => ["ws-1"], mintUid: mintSequence("uid-s-"), isStoreError: isTestStoreError });
    await store.enable();
    expect(store.writeRefusal()).toBe("the task database is missing, though a copy of it set aside is still there");
    expect(store.recovery()).toEqual({ kind: "missing", backups: [] });
    // Nothing moved in its place: no import, no activation.
    expect(db.migration()).toBe("none");
    await store.restore({ kind: "empty" });
    expect(store.recovery()).toBeNull();
    await store.write({ workspaceId: "ws-1", board: board([task({ id: "task-1" })], 2) });
    expect(db.boards().map((b) => b.workspace)).toEqual(["ws-1"]);
  });

  it("a new database started in a missing one's place takes in the boards still in their files", async () => {
    const files = [file("ws-1", encodeBoard(board([task({ id: "task-1" })], 2)))];
    const db = testDatabase(files);
    db.setStatus({ kind: "missing", detail: "a copy of it set aside is still there", backups: [] });
    const store = createDbBoardStore({ db: db.port, workspaces: () => ["ws-1"], mintUid: mintSequence("uid-s-"), isStoreError: isTestStoreError });
    await store.enable();
    expect(db.legacy().length).toBe(1);
    await store.restore({ kind: "empty" });
    expect(db.migration()).toBe("active");
    expect((await readBoard(store)).tasks.map((t) => t.id)).toEqual(["task-1"]);
    expect(db.legacy()).toEqual([]);
  });

  it("learns a database gone missing from a refusal, as it learns damage", async () => {
    const { db, store } = await open();
    const b = await readBoard(store);
    db.setStatus({ kind: "missing", detail: "2 of its backups are still there", backups: [7, 3] });
    db.refuseNextApply({ code: "missing", detail: "2 of its backups are still there" });
    await expect(store.write({ workspaceId: "ws-1", board: comment(b, "x") })).rejects.toThrow("missing");
    expect(store.recovery()).toEqual({ kind: "missing", backups: [7, 3] });
    expect(store.writeRefusal()).toContain("missing");
  });

  it("keeps the boards readable from their files, and refuses writes, when they could not move", async () => {
    const good = file("ws-1", encodeBoard(board([task({ id: "task-1" })], 2)));
    const bad = file("ws-2", "not json");
    const { db, store } = await open([good, bad]);
    expect(db.migration()).toBe("none");
    expect(store.writeRefusal()).toContain("the boards could not move into the task database — ws-2");
    expect((await readBoard(store)).tasks.map((t) => t.id)).toEqual(["task-1"]);
    expect(await store.read({ workspaceId: "ws-2" })).toMatchObject({ kind: "unreadable" });
    await expect(store.write({ workspaceId: "ws-1", board: board([], 2) })).rejects.toThrow("could not move");
  });
});
