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
