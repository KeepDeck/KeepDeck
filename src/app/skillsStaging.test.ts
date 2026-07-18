import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import type { SkillsStagingViews } from "../ipc/skills";
import { invalidateSkillsStaging, stagedSkillsFor } from "./skillsStaging";

const wire = vi.hoisted(() => ({
  stageSkills:
    vi.fn<(wsId: string, roots: string[]) => Promise<SkillsStagingViews | null>>(),
}));
vi.mock("../ipc/skills", () => ({ stageSkills: wire.stageSkills }));

/** A workspace REF: the id keys the disk, the instance keys the memo. */
const ref = (id: string, instance = `${id}-life-1`): WorkspaceRef => ({
  id,
  instance,
});

const views = (wsId: string): SkillsStagingViews => ({
  claudePluginDir: `/staging/${wsId}/claude-plugin`,
  opencodeConfigDir: `/staging/${wsId}/opencode`,
  skillsDir: `/staging/${wsId}/skills`,
});

describe("the staged-skills memo", () => {
  beforeEach(() => {
    invalidateSkillsStaging();
    wire.stageSkills.mockReset();
    wire.stageSkills.mockImplementation(async (wsId) => views(wsId));
  });

  it("stages once per workspace, even for concurrent callers", async () => {
    const [a, b] = await Promise.all([
      stagedSkillsFor(ref("ws-1")),
      stagedSkillsFor(ref("ws-1")),
    ]);
    expect(a).toEqual(views("ws-1"));
    expect(b).toEqual(a);
    expect(wire.stageSkills).toHaveBeenCalledTimes(1);

    await stagedSkillsFor(ref("ws-2"));
    expect(wire.stageSkills).toHaveBeenCalledTimes(2);
  });

  it("a reused id with a NEW instance re-stages — but to the same disk id", async () => {
    // The close's prune may have deleted the dead lifetime's dirs; serving
    // the memoized promise would hand the reborn workspace vanished paths.
    await stagedSkillsFor(ref("ws-1", "life-1"));
    await stagedSkillsFor(ref("ws-1", "life-2"));
    expect(wire.stageSkills).toHaveBeenCalledTimes(2);
    // The DISK key is the durable id — that's where the user's library is.
    expect(wire.stageSkills).toHaveBeenLastCalledWith("ws-1", []);
  });

  it("re-stages after a library edit invalidates the memo", async () => {
    await stagedSkillsFor(ref("ws-1"));
    invalidateSkillsStaging();
    await stagedSkillsFor(ref("ws-1"));
    expect(wire.stageSkills).toHaveBeenCalledTimes(2);
  });

  it("a changed worktree set re-stages — a new worktree must be armed now", async () => {
    await stagedSkillsFor(ref("ws-1"), ["/wt/a"]);
    await stagedSkillsFor(ref("ws-1"), ["/wt/a"]);
    expect(wire.stageSkills).toHaveBeenCalledTimes(1);

    await stagedSkillsFor(ref("ws-1"), ["/wt/a", "/wt/b"]);
    expect(wire.stageSkills).toHaveBeenCalledTimes(2);
    expect(wire.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/a", "/wt/b"]);

    // Order and duplicates don't matter — the set does.
    await stagedSkillsFor(ref("ws-1"), ["/wt/b", "/wt/a", "/wt/b"]);
    expect(wire.stageSkills).toHaveBeenCalledTimes(2);
  });

  it("remembers an empty result — panes must not re-stage per spawn", async () => {
    wire.stageSkills.mockResolvedValue(null);
    expect(await stagedSkillsFor(ref("ws-1"))).toBeNull();
    expect(await stagedSkillsFor(ref("ws-1"))).toBeNull();
    expect(wire.stageSkills).toHaveBeenCalledTimes(1);
  });
});
