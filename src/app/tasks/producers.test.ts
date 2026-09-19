import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER_ACTOR, agentActor } from "../../domain/tasks";
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

  it("blocked warns with the assignee; done informs", () => {
    const t = task({ id: "task-1", title: "Store", assignee: "impl-2", status: "blocked" });
    announceTask({ kind: "blocked", workspaceId: "ws-1", task: t, actor: agentActor("impl-2", "team-1") }, deps);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "task-1 is blocked", body: "Store · impl-2 · api", severity: "warning" }),
    );
    announceTask({ kind: "done", workspaceId: "ws-1", task: { ...t, status: "done" }, actor: USER_ACTOR }, deps);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "task-1 accepted", body: "Store · api", severity: "info" }),
    );
  });

  it("a workspace the deck no longer holds gets no notification — there is nothing to open", () => {
    announceTask({ kind: "done", workspaceId: "ws-9", task: task({ id: "task-1" }), actor: lead }, deps);
    expect(notify).not.toHaveBeenCalled();
  });
});
