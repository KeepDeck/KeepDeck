import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  armDoubles,
  plantingsFor,
  cwdArming,
  ref,
  skills,
  stagedFor,
  type DeckEntry,
  type WorktreePlantings,
} from "./testSupport";
import { createStagingTrimStore, type StagingTrimStore } from "../stagingTrims";

let deck: DeckEntry[] = [];
let plantings: WorktreePlantings;

beforeEach(() => {
  vi.resetAllMocks();
  deck = [];
  armDoubles();
  plantings = plantingsFor(() => deck);
});

describe("skillsFor", () => {
  it("stages afresh for every launch, concurrent ones included", async () => {
    const [a, b] = await Promise.all([
      plantings.skillsFor(ref("ws-1")),
      plantings.skillsFor(ref("ws-1")),
    ]);
    expect(a).toEqual(stagedFor("ws-1"));
    expect(b).toEqual(a);
    expect(skills.stageSkills).toHaveBeenCalledTimes(2);

    await plantings.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(3);
  });

  it("never hands a later launch what an earlier stage came out short of", async () => {
    // The codex pane that found one skill in .agents/skills: the first stage
    // saw only the bundled tier, and every later launch in the workspace was
    // served that same answer until the user edited a skill.
    const short = { dir: "/staging/ws-1/skills", skills: [{ name: "artifacts", content: "---\ndescription: A\n---\n" }] };
    skills.stageSkills.mockResolvedValueOnce({ view: short, trims: [] });
    expect(await plantings.skillsFor(ref("ws-1"))).toEqual(short);

    expect(await plantings.skillsFor(ref("ws-1"))).toEqual(stagedFor("ws-1"));
  });

  it("stages to the durable workspace id, whichever lifetime asks", async () => {
    await plantings.skillsFor(ref("ws-1", "life-2"));
    // The DISK key is the durable id — that's where the user's library is.
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", []);
  });

  it("stages without the rows the codec finds no description in — judged here, not natively", async () => {
    skills.fetchSkills.mockResolvedValue([
      { scope: "global", wsId: null, name: "fine", content: "---\ndescription: Reviews\n---\n" },
      { scope: "global", wsId: null, name: "bare", content: "no frontmatter" },
    ]);
    await plantings.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", [
      { scope: "global", wsId: null, name: "bare" },
    ]);
  });

  it("stages nothing when the library cannot be read to judge it — and asks again next time", async () => {
    skills.fetchSkills.mockRejectedValueOnce(new Error("unreadable"));
    expect(await plantings.skillsFor(ref("ws-1"))).toBeNull();
    expect(skills.stageSkills).not.toHaveBeenCalled();

    expect(await plantings.skillsFor(ref("ws-1"))).toEqual(stagedFor("ws-1"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(1);
  });

  it("a failed stage costs its own launch alone", async () => {
    // One transient error used to cost every later pane in the workspace its
    // skills until the user happened to edit one (task-568).
    skills.stageSkills.mockRejectedValueOnce(new Error("disk full"));
    expect(await plantings.skillsFor(ref("ws-1"))).toBeNull();

    expect(await plantings.skillsFor(ref("ws-1"))).toEqual(stagedFor("ws-1"));
  });
});

describe("what staging could not hand out whole", () => {
  const linkOut = { scope: "global" as const, skill: "review", kind: "link-out" as const, path: "lib", count: 1 };
  let trims: StagingTrimStore;

  beforeEach(() => {
    trims = createStagingTrimStore();
    plantings = plantingsFor(() => deck, trims);
    deck = [{ id: "ws-1" }];
  });

  it("is said under the workspace lifetime that staged it, and only beside the views", async () => {
    skills.stageSkills.mockResolvedValue({ view: stagedFor("ws-1"), trims: [linkOut] });
    // The spawn is handed the views alone.
    expect(await plantings.skillsFor(ref("ws-1"))).toEqual(stagedFor("ws-1"));
    expect(trims.get()).toEqual([
      { ...linkOut, workspaceId: "ws-1", workspaceInstance: "ws-1-life-1", workspaceName: "ws-1" },
    ]);
  });

  it("is not said by the stage of a lifetime that is gone, even once a new workspace holds its id", async () => {
    // Closed while its stage was in flight, and the slot handed to a new
    // workspace: that one has not staged yet, so nothing stands under it.
    deck = [{ id: "ws-1", instance: "life-2" }];
    skills.stageSkills.mockResolvedValue({ view: stagedFor("ws-1"), trims: [linkOut] });
    await plantings.skillsFor(ref("ws-1", "life-1"));
    expect(trims.get()).toEqual([]);
  });

  it("is replaced by the workspace's next stage — a fixed skill leaves the list", async () => {
    skills.stageSkills.mockResolvedValueOnce({ view: stagedFor("ws-1"), trims: [linkOut] });
    await plantings.skillsFor(ref("ws-1"));
    expect(trims.get()).toHaveLength(1);

    await plantings.skillsFor(ref("ws-1"));
    expect(trims.get()).toEqual([]);
  });

  it("is forgotten the moment the library moves, before any launch stages again", async () => {
    skills.stageSkills.mockResolvedValueOnce({ view: stagedFor("ws-1"), trims: [linkOut] });
    await plantings.skillsFor(ref("ws-1"));
    plantings.invalidateSkills();
    expect(trims.get()).toEqual([]);
  });

  it("is not said by a stage asked for before the library moved", async () => {
    let answer!: (value: unknown) => void;
    skills.stageSkills.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const staging = plantings.skillsFor(ref("ws-1"));
    await vi.waitFor(() => expect(skills.stageSkills).toHaveBeenCalled());

    plantings.invalidateSkills();
    answer({ view: stagedFor("ws-1"), trims: [linkOut] });
    await staging;

    expect(trims.get()).toEqual([]);
  });

  it("survives a failed stage — a failure says nothing about the library", async () => {
    skills.stageSkills.mockResolvedValueOnce({ view: stagedFor("ws-1"), trims: [linkOut] });
    await plantings.skillsFor(ref("ws-1"));
    // The same workspace re-staged after the library moved, and failing.
    plantings.invalidateSkills();
    trims.record({ id: "ws-1", instance: "ws-1-life-1", name: "ws-1" }, [linkOut]);
    skills.stageSkills.mockRejectedValueOnce(new Error("disk full"));
    await plantings.skillsFor(ref("ws-1"));
    expect(trims.get()).toHaveLength(1);
  });
});

describe("what an agent's plugin plants in a pane's cwd", () => {
  const request = (cwd: string) => ({
    pluginId: "p",
    workspaceId: "ws-1",
    cwd,
    arms: [{ kind: "file" as const, path: ".agent/conf", content: "{}" }],
    skillsDir: null,
  });

  it("plants the request as it was handed, and answers what landed", async () => {
    deck = [{ id: "ws-1" }];
    cwdArming.cwdArm.mockResolvedValue({ armed: [".agent/conf"], refused: [] });

    expect(await plantings.armCwd(request("/repo"))).toEqual({ armed: [".agent/conf"], refused: [] });
    expect(cwdArming.cwdArm).toHaveBeenCalledWith(request("/repo"));
  });

  it("plants into a cwd the deck cannot see YET — that is the normal case", async () => {
    // A manual resume, a fork into a directory and a fork into a fresh
    // worktree all build their plan BEFORE the pane lands, so the deck does
    // not claim the cwd at write time.
    deck = [{ id: "ws-1" }];
    cwdArming.cwdArm.mockResolvedValue({ armed: [".agent/conf"], refused: [] });

    expect(await plantings.armCwd(request("/wt/landing"))).toEqual({ armed: [".agent/conf"], refused: [] });
    expect(cwdArming.cwdArm).toHaveBeenCalledWith(request("/wt/landing"));
  });
});
