import { describe, expect, it } from "vitest";
import type { Workspace } from "../domain/deck";
import type { IntentOutcome } from "../domain/lifecycle";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { archiveConfirmView, archiveRefusalText } from "./archiveView";
import { intentOutcomeText } from "./lifecycleWords";

const AT = "2026-11-16T00:00:00.000Z";
const ws = (panes: Workspace["panes"]): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "Web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes,
});
const first = (view: { message: string }) => view.message.split("\n\n")[0];

describe("archiveConfirmView", () => {
  it("says how many agents stop, as the machine counts them, apart from those already suspended", () => {
    const view = archiveConfirmView(
      ws([
        { id: "running", agentType: "claude" },
        { id: "parked", agentType: "claude", idle: { reason: "parked" } },
        { id: "mine", agentType: "claude", idle: { reason: "suspended", at: AT } },
      ]),
      2,
    );
    expect(view.title).toBe("Archive “Web”?");
    expect(first(view)).toMatch(/^2 agents stop; 1 already suspended stays so\./);
    expect(view.confirmLabel).toBe("Archive");
  });

  it("says what becomes of a remote agent: it keeps running on its server", () => {
    const view = archiveConfirmView(ws([{ id: "far", agentType: "codex", location: { kind: "remote", endpoint: "ws://vps" } }]), 0);
    expect(first(view)).toMatch(/^1 remote agent keeps running on its server; only the connection here closes\./);
  });

  it("speaks of a workspace whose agents are all suspended, and of one with none", () => {
    expect(first(archiveConfirmView(ws([{ id: "mine", agentType: "claude", idle: { reason: "suspended", at: AT } }]), 0))).toMatch(
      /^Its agents are already suspended\./,
    );
    expect(first(archiveConfirmView(ws([]), 0))).toMatch(/^It has no agents\./);
  });

  it("promises what is true: nothing deleted, nobody woken by Restore, where to find it", () => {
    const { message } = archiveConfirmView(ws([{ id: "running", agentType: "claude" }]), 1);
    expect(message).toContain("Restore brings the workspace back with its agents still stopped");
    expect(message).toContain("resumes where it stopped when you resume it, if its agent can");
    expect(message).toContain("nothing of the workspace is deleted");
    expect(message).toContain("Find it under Archived");
  });
});

describe("archiveRefusalText", () => {
  const refused = (kind: "alreadyClosing" | "targetLeaving" | "notFound" | "archived" | "barrierUp"): IntentOutcome => ({
    kind: "refused",
    refusal: { kind },
  });

  it("speaks only of a refusal — the archive's own by the workspace's name, any other in the machine's words", () => {
    expect(archiveRefusalText(refused("alreadyClosing"), "Web")).toBe("“Web” is being closed, so it cannot be archived.");
    expect(archiveRefusalText(refused("targetLeaving"), "Web")).toBe("“Web” is being closed, so it cannot be archived.");
    expect(archiveRefusalText(refused("notFound"), "Web")).toBe("“Web” is no longer open.");
    // Archived already, elsewhere: nothing to say.
    expect(archiveRefusalText(refused("archived"), "Web")).toBeNull();
    expect(archiveRefusalText({ kind: "accepted", op: 1, minted: { workspace: null, team: null, panes: [] } }, "Web")).toBeNull();
    expect(archiveRefusalText(refused("barrierUp"), "Web")).toBe(intentOutcomeText(refused("barrierUp")));
  });
});
