import { describe, expect, it } from "vitest";
import { migrationLines } from "./migrationLog";

describe("migrationLines — the move, board by board, in the log", () => {
  it("says what moved, what was adapted, and warns of a board kept unattached", () => {
    expect(
      migrationLines({
        kind: "active",
        moved: [
          { workspace: "ws-1", attached: true, adapted: false },
          { workspace: "ws-5", attached: true, adapted: true },
          { workspace: "ws-9", attached: false, adapted: false },
        ],
      }),
    ).toEqual([
      { level: "info", text: "board of ws-1 moved into the task database" },
      { level: "info", text: "board of ws-5 moved into the task database, adapted from an older shape" },
      { level: "warn", text: "board of ws-9 moved into the task database UNATTACHED — the deck has no such workspace; kept, shown nowhere" },
    ]);
  });

  it("warns, with the reason, when nothing moved", () => {
    expect(migrationLines({ kind: "failed", reason: "ws-2: not JSON" })).toEqual([
      { level: "warn", text: "the boards stay in their files, read-only: ws-2: not JSON" },
    ]);
  });
});
