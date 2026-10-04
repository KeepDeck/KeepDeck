import { describe, expect, it } from "vitest";
import { task } from "../../domain/tasks/testSupport";
import { createdWords, movedWords } from "./notificationWords";

describe("the board's notification words", () => {
  it("says a task put on the board, or parked in the backlog — not one to take", () => {
    expect(createdWords(task({ id: "task-1", title: "Idea" }), "impl-1", "web").title).toBe("impl-1 put a task on web's board");
    expect(createdWords(task({ id: "task-1", status: "backlog" }), "impl-1", "web").title).toBe("impl-1 parked a task in web's backlog");
    expect(createdWords(task({ id: "task-1" }), null, "web").title).toBe("an agent put a task on web's board");
  });

  it("names each move by where it went, and where it came from where that matters", () => {
    const title = (from: Parameters<typeof movedWords>[1], to: Parameters<typeof task>[0]["status"]) =>
      movedWords(task({ id: "task-1", status: to }), from, "web").title;
    expect(title("todo", "backlog")).toBe("task-1 moved to the backlog");
    expect(title("backlog", "todo")).toBe("task-1 is ready to start");
    expect(title("done", "todo")).toBe("task-1 reopened");
    // Started from the ladder's start — waiting, or parked — not "back".
    expect(title("todo", "in-progress")).toBe("task-1 started");
    expect(title("backlog", "in-progress")).toBe("task-1 started");
    expect(title("review", "in-progress")).toBe("task-1 back in progress");
    expect(movedWords(task({ id: "task-1", status: "blocked" }), "in-progress", "web").severity).toBe("warning");
  });
});
