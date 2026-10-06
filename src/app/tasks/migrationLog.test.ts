import { describe, expect, it } from "vitest";
import { migrationLines } from "./migrationLog";

describe("migrationLines — the move, board by board, in the log", () => {
  it("says what moved, what was adapted, and warns of a board kept unattached", () => {
    expect(
      migrationLines({
        kind: "active",
        moved: [
          { workspace: "ws-1", attached: true, adapted: false, dropped: [] },
          { workspace: "ws-5", attached: true, adapted: true, dropped: [{ id: "task-3", blockers: ["task-3", "task-40"] }] },
          { workspace: "ws-9", attached: false, adapted: false, dropped: [] },
        ],
        retireError: null,
      }),
    ).toEqual([
      { level: "info", text: "board of ws-1 moved into the task database" },
      { level: "warn", text: "board of ws-5: task-3's blockers task-3, task-40 held nothing (itself, or not on the board) — let go" },
      { level: "info", text: "board of ws-5 moved into the task database, adapted from an older shape" },
      { level: "warn", text: "board of ws-9 moved into the task database UNATTACHED — the deck has no such workspace; kept, shown nowhere" },
    ]);
  });

  it("warns when the files left could not all become copies — the boards moved all the same", () => {
    expect(migrationLines({ kind: "active", moved: [], retireError: "the disk refused: ws-1" })).toEqual([
      { level: "warn", text: "the board files left could not all become copies (tried again at the next enable): the disk refused: ws-1" },
    ]);
  });

  it("warns, with the reason, when nothing moved", () => {
    expect(migrationLines({ kind: "failed", reason: "ws-2: not JSON" })).toEqual([
      { level: "warn", text: "the boards stay in their files, read-only: ws-2: not JSON" },
    ]);
  });
});
