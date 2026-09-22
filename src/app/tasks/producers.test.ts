import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER_ACTOR, agentActor, type TaskStatus } from "../../domain/tasks";
import { task } from "../../domain/tasks/testSupport";
import { announceTask } from "./producers";
import { teamedWorkspaces } from "./testSupport";

vi.mock("../notificationCenter", () => ({ notify: vi.fn() }));
import { notify } from "../notificationCenter";

const workspaces = teamedWorkspaces();
const deps = { workspaces: () => workspaces };
const lead = agentActor("lead", "team-1");

describe("announceTask", () => {
  beforeEach(() => vi.mocked(notify).mockReset());

  it("an agent's creation notifies, naming the role, the team and the task; one slot per task", () => {
    const t = task({ id: "task-3", title: "Write the skill", assignee: "impl-1" });
    announceTask({ kind: "created", workspaceId: "ws-1", task: t, actor: lead }, deps);
    expect(notify).toHaveBeenCalledWith({
      title: "lead put a task on api's board",
      body: "task-3 · Write the skill",
      severity: "info",
      source: { type: "tasks", workspace: { id: "ws-1", instance: workspaces[0].instance }, taskId: "task-3" },
      tag: "tasks:ws-1:task-3",
    });
  });

  it("the user's own creation says nothing — the board is in front of them", () => {
    announceTask({ kind: "created", workspaceId: "ws-1", task: task({ id: "task-1" }), actor: USER_ACTOR }, deps);
    expect(notify).not.toHaveBeenCalled();
  });

  it("every move along the ladder notifies, named for where it went; only blocked warns", () => {
    const moves: [TaskStatus, TaskStatus, string][] = [
      ["todo", "in-progress", "task-1 started"],
      ["in-progress", "blocked", "task-1 is blocked"],
      ["blocked", "in-progress", "task-1 back in progress"],
      ["in-progress", "review", "task-1 is ready for review"],
      ["review", "in-progress", "task-1 back in progress"],
      ["review", "done", "task-1 accepted"],
      ["done", "todo", "task-1 reopened"],
      ["todo", "cancelled", "task-1 cancelled"],
    ];
    for (const [from, to, title] of moves) {
      const t = task({ id: "task-1", title: "Store", assignee: "impl-2", status: to });
      announceTask({ kind: "moved", from, workspaceId: "ws-1", task: t, actor: agentActor("impl-2", "team-1") }, deps);
      expect(notify).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title,
          body: "Store · impl-2 · api",
          severity: to === "blocked" ? "warning" : "info",
          tag: "tasks:ws-1:task-1",
        }),
      );
    }
    expect(notify).toHaveBeenCalledTimes(moves.length);
  });

  it("the person's own move notifies too — the board changed, whoever moved it", () => {
    const t = task({ id: "task-1", status: "done" });
    announceTask({ kind: "moved", from: "todo", workspaceId: "ws-1", task: t, actor: USER_ACTOR }, deps);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: "task-1 accepted", body: "Task task-1 · unassigned · api" }));
  });

  it("a workspace the deck no longer holds gets no notification — there is nothing to open", () => {
    announceTask({ kind: "moved", from: "review", workspaceId: "ws-9", task: task({ id: "task-1" }), actor: lead }, deps);
    expect(notify).not.toHaveBeenCalled();
  });
});
