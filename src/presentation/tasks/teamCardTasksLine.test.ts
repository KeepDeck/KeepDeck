import { describe, expect, it } from "vitest";
import { task } from "../../domain/tasks/testSupport";
import { teamCardTasksLine } from "./teamCardTasksLine";

describe("teamCardTasksLine", () => {
  it("counts what is open and what waits on a person; a finished board says done; an empty one says nothing", () => {
    expect(
      teamCardTasksLine([
        task({ id: "task-1" }),
        task({ id: "task-2", status: "in-progress" }),
        task({ id: "task-3", status: "blocked" }),
        task({ id: "task-4", status: "review" }),
        task({ id: "task-5", status: "review" }),
        task({ id: "task-6", status: "done" }),
      ]),
    ).toBe("2 open · 1 blocked · 2 in review");
    expect(teamCardTasksLine([task({ id: "task-1" })])).toBe("1 open");
    expect(teamCardTasksLine([task({ id: "task-1", status: "done" }), task({ id: "task-2", status: "cancelled" })])).toBe("1 done");
    expect(teamCardTasksLine([])).toBeNull();
  });
});
