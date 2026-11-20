import { describe, expect, it } from "vitest";
import type { WorktreeTeardownFailure } from "../domain/deck";
import {
  closeMessageFor,
  teardownFailureText,
  worktreeNotDeletedNotice,
  worktreesNotDeletedText,
  type CloseWordsTarget,
} from "./closeWords";

describe("worktreeNotDeletedNotice", () => {
  it("says the folder and the reason the cleanup was given, under the close's own heading", () => {
    expect(worktreeNotDeletedNotice("/wt/1", "could not remove /wt/1: busy")).toEqual({
      title: "Failed to delete worktree",
      body: "/wt/1: could not remove /wt/1: busy",
    });
  });
});

describe("closeMessageFor", () => {
  type AgentFacts = Extract<CloseWordsTarget, { kind: "agent" }>["pane"];
  const agent = (pane: Partial<AgentFacts> = {}, targets = 0): CloseWordsTarget => ({
    kind: "agent",
    pane: {
      provisioning: false,
      rising: false,
      stopped: false,
      canSuspend: false,
      ...pane,
    },
    // A last member exactly when there is a worktree to offer: the offer
    // is the team's, and only the last member's dialog carries it.
    last: targets > 0 ? { name: "wt", targets: Array.from({ length: targets }, (_, i) => `/wt/${i}`) } : null,
  });
  const team = (count: number): CloseWordsTarget => ({ kind: "team", count });
  const whole = (count: number): CloseWordsTarget => ({ kind: "workspace", count });

  it("says nothing without a target", () => {
    expect(closeMessageFor(null, 0)).toBe("");
  });

  it("describes what closing an AGENT does, per state", () => {
    // The four sentences this dialog can say about one pane, side by side —
    // three of them were wrong at some point, each caught only through the
    // whole hook.
    expect(closeMessageFor(agent(), 0)).toBe("Its terminal session will be ended.");
    expect(closeMessageFor(agent({ stopped: true }), 0)).toBe(
      "It is stopped; closing removes the pane.",
    );
    expect(closeMessageFor(agent({ rising: true }), 0)).toBe(
      "It is starting up; closing removes the pane.",
    );
    expect(closeMessageFor(agent({ provisioning: true }), 0)).toBe(
      "Its worktree is still being created.",
    );
  });

  it("tells the last member what each verb does to its team, ahead of the pane's own sentence", () => {
    const message = closeMessageFor(agent({}, 1), 0);
    expect(message.startsWith("It is the last agent on “wt”.")).toBe(true);
    expect(message).toContain("Disbanding removes the team as well");
    expect(message).toContain("closing the agent alone keeps the team");
    expect(message.endsWith("Its terminal session will be ended.")).toBe(true);
  });

  it("never mentions a worktree the confirm would not delete", () => {
    // The default path keeps it — the checkbox owns that decision. The only
    // place a worktree may be named is the SUSPEND alternative, which keeps
    // it on purpose.
    expect(closeMessageFor(agent({}, 1), 0)).not.toContain("worktree");
    expect(closeMessageFor(agent({ stopped: true }, 1), 0)).not.toContain(
      "worktree",
    );
    expect(closeMessageFor(agent({ canSuspend: true }, 1), 0)).toContain(
      "keeping the pane, its worktree and its session",
    );
    // No worktree to keep: the sentence must not invent one.
    expect(closeMessageFor(agent({ canSuspend: true }, 0), 0)).toContain(
      "keeping the pane and its session",
    );
  });

  it("offers the alternative only alongside a session to keep", () => {
    // A stopped pane is exactly the one the suspend offer refuses, so these
    // two can never combine — pinned because the old inline version could
    // spell the combination and nothing said it was impossible.
    expect(
      closeMessageFor(agent({ stopped: true, canSuspend: true }), 0),
    ).not.toContain("Suspending");
  });

  it("counts only a workspace's agents that still hold a session", () => {
    expect(closeMessageFor(whole(0), 0)).toBe("This workspace has no agents.");
    expect(closeMessageFor(whole(3), 3)).toBe(
      "This ends 3 agents and their sessions.",
    );
    expect(closeMessageFor(whole(2), 1)).toBe(
      "This ends 1 agent and its session.",
    );
    // None running says so in the one way that is true of every reason for
    // having no session — stopped, still rising, or mid-create.
    expect(closeMessageFor(whole(2), 0)).toBe(
      "This ends no sessions; closing removes 2 agents.",
    );
    expect(closeMessageFor(whole(1), 0)).toBe(
      "This ends no session; closing removes 1 agent.",
    );
  });

  it("says a disband removes the team, and counts its members the same way", () => {
    expect(closeMessageFor(team(0), 0)).toBe(
      "This team has no agents; disbanding removes the team.",
    );
    expect(closeMessageFor(team(3), 3)).toBe(
      "This ends 3 agents and their sessions. The team is removed.",
    );
    expect(closeMessageFor(team(2), 0)).toBe(
      "This ends no sessions; disbanding removes 2 agents. The team is removed.",
    );
    // The carrier line rides a disband too — a team's conversations can be
    // carried like a workspace's.
    expect(closeMessageFor(team(2), 2, { kind: "background" })).toContain(
      "At least one conversation is carried",
    );
  });
});

describe("teardownFailureText", () => {
  const named = { repo: "/r", path: "/wt/1", branch: "kd/ws/1" };
  const nameless = { repo: "/r", path: "/wt/2" };

  it("names the branch when it is known, the folder when not", () => {
    expect(teardownFailureText({ kind: "held-elsewhere", target: named })).toBe(
      "kd/ws/1: another workspace still works in this folder",
    );
    expect(teardownFailureText({ kind: "held-elsewhere", target: nameless })).toBe(
      "/wt/2: another workspace still works in this folder",
    );
  });

  it("says git's own reason when git refused", () => {
    expect(teardownFailureText({ kind: "git-refused", target: named, reason: "Error: dirty" })).toBe(
      "kd/ws/1: Error: dirty",
    );
  });
});

describe("worktreesNotDeletedText", () => {
  const failure = (path: string): WorktreeTeardownFailure => ({
    kind: "git-refused",
    target: { repo: "/r", path },
    reason: "Error: dirty",
  });

  it("heads one line per worktree left in place, singular for one", () => {
    expect(worktreesNotDeletedText([failure("/wt/1")])).toBe("Failed to delete worktree:\n/wt/1: Error: dirty");
    expect(worktreesNotDeletedText([failure("/wt/1"), failure("/wt/2")])).toBe(
      "Failed to delete worktrees:\n/wt/1: Error: dirty\n/wt/2: Error: dirty",
    );
  });
});
