import { describe, expect, it, vi } from "vitest";
import type { Cmd } from "../../ipc/generated/lifecycle/Cmd";
import type { CommandOwner } from "../lifecycleSnapshot";
import { createBoardsOwner } from "./boards";
import { createMailOwner } from "./mail";
import { createNoticesOwner } from "./notices";

describe("the notices' owner", () => {
  it("leaves one notice per worktree a cleanup could not delete, replaced rather than stacked", async () => {
    const notify = vi.fn(() => true);
    const owner = createNoticesOwner({ notify });
    const cmd: Cmd = { kind: "worktreeNotDeleted", workspace: "ws-a", path: "/wt/1", reason: "busy" };
    expect(await carry(owner, cmd)).toEqual({ kind: "applied", revision: null });
    await carry(owner, cmd);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Failed to delete worktree", body: "/wt/1: busy", severity: "warning", tag: "worktree-not-deleted:/wt/1" }));
    expect((await carry(owner, { kind: "retainPanes", panes: [] })).kind).toBe("rejected");
  });
});

const carry = (owner: CommandOwner, cmd: Cmd) => owner.carry({ id: { op: 1, index: 0 }, owner: "boards", cmd });

describe("the task boards' owner", () => {
  it("forgets a closed workspace's board and holds the boards to their teams", async () => {
    const boards = { forgetWorkspace: vi.fn(() => Promise.resolve()), retainTeams: vi.fn() };
    const owner = createBoardsOwner(boards);
    expect(await carry(owner, { kind: "forgetBoards", workspace: "ws-a" })).toEqual({ kind: "applied", revision: null });
    expect(boards.forgetWorkspace).toHaveBeenCalledWith("ws-a");
    await carry(owner, { kind: "deleteTeamTasks", workspace: "ws-a", team: "team-n" });
    await carry(owner, { kind: "retainTeams", teams: ["team-1"] });
    expect(boards.retainTeams).toHaveBeenCalledTimes(2);
    expect((await carry(owner, { kind: "forgetPaneMail", workspace: "ws-a", pane: "pane-1" })).kind).toBe("rejected");
  });

  it("answers a board that could not be dropped with the refusal the dispatch makes of it", async () => {
    const owner = createBoardsOwner({ forgetWorkspace: () => Promise.reject(new Error("disk full")), retainTeams: () => {} });
    await expect(carry(owner, { kind: "forgetBoards", workspace: "ws-a" })).rejects.toThrow("disk full");
  });
});

describe("the mail's owner", () => {
  it("forgets a closed pane's mail and, at boot, every pane's not on the deck", async () => {
    const mail = { forget: vi.fn(), retain: vi.fn() };
    const owner = createMailOwner(mail);
    expect(await carry(owner, { kind: "forgetPaneMail", workspace: "ws-a", pane: "pane-2" })).toEqual({ kind: "applied", revision: null });
    expect(mail.forget).toHaveBeenCalledWith(new Set(["pane-2"]));
    await carry(owner, { kind: "retainPanes", panes: ["pane-1", "pane-3"] });
    expect(mail.retain).toHaveBeenCalledWith(new Set(["pane-1", "pane-3"]));
    expect((await carry(owner, { kind: "forgetBoards", workspace: "ws-a" })).kind).toBe("rejected");
  });
});
