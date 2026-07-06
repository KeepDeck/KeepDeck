import { describe, expect, it } from "vitest";
import { commandRows, runSpawnOptions, type RunSession } from "./sessions";

const PRESETS = [
  { id: "run-1", name: "Dev", command: "pnpm dev" },
  { id: "run-2", name: "Tests", command: "pnpm test" },
];

const session = (over: Partial<RunSession>): RunSession => ({
  id: "s1",
  wsId: "ws-1",
  name: "Dev",
  presetId: "run-1",
  command: "pnpm dev",
  worktree: "/wt/a",
  status: { kind: "running" },
  ...over,
});

describe("commandRows", () => {
  it("gives every preset a row, idle ones included", () => {
    const rows = commandRows(PRESETS, [], "/wt/a");
    expect(rows).toEqual([
      { preset: PRESETS[0], elsewhere: [] },
      { preset: PRESETS[1], elsewhere: [] },
    ]);
  });

  it("fuses the CURRENT target's session into its preset's row", () => {
    const here = session({ worktree: "/wt/a" });
    const rows = commandRows(PRESETS, [here], "/wt/a");
    expect(rows[0].session).toBe(here);
    expect(rows[0].elsewhere).toEqual([]);
  });

  it("instances in other targets go to elsewhere — the row answers for HERE", () => {
    const there = session({ id: "s2", worktree: "/wt/b" });
    const rows = commandRows(PRESETS, [there], "/wt/a");
    expect(rows[0].session).toBeUndefined();
    expect(rows[0].elsewhere).toEqual([there]);
  });

  it("splits here/elsewhere when a command runs in several targets", () => {
    const here = session({ id: "s1", worktree: "/wt/a" });
    const there = session({ id: "s2", worktree: "/wt/b" });
    const rows = commandRows(PRESETS, [here, there], "/wt/a");
    expect(rows[0].session).toBe(here);
    expect(rows[0].elsewhere).toEqual([there]);
  });

  it("a session whose preset is gone trails as an orphan row", () => {
    const orphan = session({ id: "s3", presetId: "run-9", name: "old dev" });
    const rows = commandRows(PRESETS, [orphan], "/wt/a");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ session: orphan, elsewhere: [] });
  });
});

describe("runSpawnOptions", () => {
  it("spawns the user's shell with -c and the env contract, cwd = worktree", () => {
    expect(
      runSpawnOptions({
        command: "pnpm dev",
        worktree: "/wt/a",
        branch: "kd/a",
        port: 17_040,
      }),
    ).toMatchObject({
      command: null,
      args: ["-c", "pnpm dev"],
      cwd: "/wt/a",
      env: [
        ["KEEPDECK_WORKTREE", "/wt/a"],
        ["KEEPDECK_BRANCH", "kd/a"],
        ["KEEPDECK_PORT", "17040"],
      ],
    });
  });
});
