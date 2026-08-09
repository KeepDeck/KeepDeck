import { describe, expect, it, vi } from "vitest";
import { parseSkillFile, type SkillDraft, type SkillScope } from "../domain/skills";
import {
  createSkillsLibrary,
  type SkillsLibrary,
  type SkillsStorage,
} from "./skillsLibrary";
import type { StoredSkill } from "../ipc/skills";

const GLOBAL: SkillScope = { kind: "global" };
const WS: SkillScope = { kind: "workspace", wsId: "ws-1" };

const draft = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  name: "review-diff",
  description: "Use when reviewing a diff",
  body: "Read the diff first.\n",
  extraFrontmatter: [],
  ...over,
});

function libraryOver(over: Partial<SkillStorageFakes> = {}) {
  const storage = {
    fetch: vi.fn<() => Promise<StoredSkill[]>>(async () => []),
    save: vi.fn<SkillsStorage["save"]>(async () => {}),
    rename: vi.fn<SkillsStorage["rename"]>(async () => {}),
    remove: vi.fn<SkillsStorage["remove"]>(async () => {}),
  };
  Object.assign(storage, over);
  const invalidateSkills = vi.fn();
  const library: SkillsLibrary = createSkillsLibrary({
    storage,
    staging: { invalidateSkills },
  });
  return { library, storage, invalidateSkills };
}
type SkillStorageFakes = {
  fetch: SkillsStorage["fetch"];
  save: SkillsStorage["save"];
  rename: SkillsStorage["rename"];
  remove: SkillsStorage["remove"];
};

/** The SKILL.md a save was handed, parsed back. */
const written = (save: { mock: { calls: unknown[][] } }) =>
  parseSkillFile(save.mock.calls[0]?.[2] as string);

describe("a write reports the library as changed", () => {
  // Without this the staged views a pane spawn injects keep yesterday's
  // library, so a skill saves fine and never reaches an agent.
  it("invalidates the staged views after a create", async () => {
    const { library, invalidateSkills } = libraryOver();
    await library.create(GLOBAL, draft());
    expect(invalidateSkills).toHaveBeenCalledTimes(1);
  });

  it("invalidates after an update, a rename and a remove", async () => {
    const { library, invalidateSkills } = libraryOver();
    await library.update(WS, draft());
    await library.rename(WS, "review-diff", "review-patch");
    await library.remove(WS, "review-patch");
    expect(invalidateSkills).toHaveBeenCalledTimes(3);
  });

  it("does NOT invalidate when the write failed", async () => {
    // Nothing changed on disk, so re-staging the library would be pure waste.
    const { library, invalidateSkills } = libraryOver({
      save: vi.fn(async () => {
        throw new Error("read-only fs");
      }),
    });
    await expect(library.create(GLOBAL, draft())).rejects.toThrow("read-only fs");
    expect(invalidateSkills).not.toHaveBeenCalled();
  });

  it("does not invalidate on a read", async () => {
    const { library, invalidateSkills } = libraryOver();
    await library.list();
    expect(invalidateSkills).not.toHaveBeenCalled();
  });
});

describe("create and update differ only in what they refuse", () => {
  it("create claims the name, so the backend can refuse a collision", async () => {
    const { library, storage } = libraryOver();
    await library.create(GLOBAL, draft());
    expect(storage.save).toHaveBeenCalledWith(
      GLOBAL,
      "review-diff",
      expect.any(String),
      true,
    );
  });

  it("update overwrites in place", async () => {
    const { library, storage } = libraryOver();
    await library.update(WS, draft());
    expect(storage.save).toHaveBeenCalledWith(WS, "review-diff", expect.any(String), false);
  });

  it("composes the stored file through the domain, keeping hand-added keys", async () => {
    const { library, storage } = libraryOver();
    await library.create(GLOBAL, draft({ extraFrontmatter: ["allowed-tools: Read"] }));
    const back = written(storage.save);
    expect(back.name).toBe("review-diff");
    expect(back.description).toBe("Use when reviewing a diff");
    expect(back.body).toBe("Read the diff first.\n");
    expect(back.extraFrontmatter).toEqual(["allowed-tools: Read"]);
  });
});

describe("what the library refuses", () => {
  it("rejects an invalid name, and writes nothing", async () => {
    const { library, storage } = libraryOver();
    await expect(library.create(GLOBAL, draft({ name: "Review Diff" }))).rejects.toThrow(
      /not a valid skill name/,
    );
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("rejects an empty description — a skill without one never takes effect", async () => {
    // The editor blocks this for the same reason; the guard has to hold on
    // every path, or a skill created through a command is one the UI forbids.
    const { library, storage } = libraryOver();
    await expect(library.create(GLOBAL, draft({ description: "   " }))).rejects.toThrow(
      /needs a description/,
    );
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("folds a multi-line description instead of rejecting it", async () => {
    // An agent writing a wrapped paragraph should get a valid scalar, not an
    // error it cannot act on.
    const { library, storage } = libraryOver();
    await library.create(
      GLOBAL,
      draft({ description: "Use when reviewing\n   a diff carefully" }),
    );
    expect(written(storage.save).description).toBe("Use when reviewing a diff carefully");
  });

  it("rejects renaming TO an invalid name, and moves nothing", async () => {
    const { library, storage } = libraryOver();
    await expect(library.rename(GLOBAL, "review-diff", "Review Diff")).rejects.toThrow(
      /not a valid skill name/,
    );
    expect(storage.rename).not.toHaveBeenCalled();
  });

  it("reports a refusal as a rejection, never a synchronous throw", async () => {
    // A caller that only `.catch`es — every command handler — would otherwise
    // see a validation error escape past it.
    const { library } = libraryOver();
    let caught: unknown = null;
    const settled = library
      .rename(GLOBAL, "a", "NOT VALID")
      .catch((e: unknown) => (caught = e));
    await settled;
    expect(caught).toBeInstanceOf(Error);
  });
});

describe("reading one skill", () => {
  const rows: StoredSkill[] = [
    {
      scope: "global",
      wsId: null,
      name: "review",
      content: "---\nname: review\ndescription: Global one\nlicense: MIT\n---\nGlobal body\n",
    },
    {
      scope: "workspace",
      wsId: "ws-1",
      name: "review",
      content: "---\nname: review\ndescription: Workspace one\n---\nWs body\n",
    },
  ];

  it("returns the draft, keeping hand-added frontmatter", async () => {
    const { library } = libraryOver({ fetch: vi.fn(async () => rows) });
    expect(await library.read(GLOBAL, "review")).toEqual({
      name: "review",
      description: "Global one",
      body: "Global body\n",
      extraFrontmatter: ["license: MIT"],
    });
  });

  it("does not confuse one scope's skill with another's of the same name", async () => {
    const { library } = libraryOver({ fetch: vi.fn(async () => rows) });
    expect((await library.read(WS, "review"))?.description).toBe("Workspace one");
  });

  it("answers null for a skill that scope does not hold", async () => {
    const { library } = libraryOver({ fetch: vi.fn(async () => rows) });
    expect(await library.read(GLOBAL, "deploy")).toBeNull();
    expect(await library.read({ kind: "workspace", wsId: "ws-9" }, "review")).toBeNull();
  });

  it("prefers the directory name over a disagreeing frontmatter name", async () => {
    // Every CLI keys on the directory; a hand edit can leave the two apart,
    // and an update must write back to the directory that exists.
    const { library } = libraryOver({
      fetch: vi.fn(async () => [
        {
          scope: "global" as const,
          wsId: null,
          name: "on-disk",
          content: "---\nname: stale-in-file\ndescription: d\n---\n",
        },
      ]),
    });
    expect((await library.read(GLOBAL, "on-disk"))?.name).toBe("on-disk");
  });
});

describe("reading the library", () => {
  it("passes the stored list through", async () => {
    const stored: StoredSkill[] = [
      { scope: "global", wsId: null, name: "a", content: "---\nname: a\n---\n" },
    ];
    const { library } = libraryOver({ fetch: vi.fn(async () => stored) });
    expect(await library.list()).toEqual(stored);
  });

  it("throws when the library cannot be read, rather than reporting it empty", async () => {
    const { library } = libraryOver({
      fetch: vi.fn(async () => {
        throw new Error("backend down");
      }),
    });
    await expect(library.list()).rejects.toThrow("backend down");
  });
});
