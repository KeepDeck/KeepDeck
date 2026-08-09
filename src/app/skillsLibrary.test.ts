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

// Named for a skill the fake library actually holds, so a mutation's existence
// precondition is satisfied unless a case deliberately breaks it.
const draft = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  name: "review",
  description: "Use when reviewing a diff",
  body: "Read the diff first.\n",
  extraFrontmatter: [],
  ...over,
});

/** The library as the backend sees it: one global and one workspace skill, both
 * named `review`, so a scope mix-up cannot pass unnoticed. */
const STORED: StoredSkill[] = [
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

function libraryOver(over: Partial<SkillStorageFakes> = {}) {
  const storage = {
    fetch: vi.fn<() => Promise<StoredSkill[]>>(async () => STORED),
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
    expect(invalidateSkills).toHaveBeenCalledTimes(1);
    await library.rename(WS, "review", "review");
    // ONE invalidation for a rename, even though it writes twice (move, then
    // rewrite the frontmatter name) — a rename is one mutation.
    expect(invalidateSkills).toHaveBeenCalledTimes(2);
    await library.remove(WS, "review");
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
      "review",
      expect.any(String),
      true,
    );
  });

  it("update overwrites in place", async () => {
    const { library, storage } = libraryOver();
    await library.update(WS, draft());
    expect(storage.save).toHaveBeenCalledWith(WS, "review", expect.any(String), false);
  });

  it("composes the stored file through the domain, keeping hand-added keys", async () => {
    const { library, storage } = libraryOver();
    await library.create(GLOBAL, draft({ extraFrontmatter: ["allowed-tools: Read"] }));
    const back = written(storage.save);
    expect(back.name).toBe("review");
    expect(back.description).toBe("Use when reviewing a diff");
    expect(back.body).toBe("Read the diff first.\n");
    expect(back.extraFrontmatter).toEqual(["allowed-tools: Read"]);
  });
});

describe("the library owns every precondition, not the door", () => {
  // The storage underneath cannot enforce these: `save` writes whether or not
  // the skill exists, and `delete` calls a missing directory a success. With the
  // guards at one door, the editor resurrected skills an agent had deleted.
  it("refuses an update of a skill that is not there, instead of creating it", async () => {
    const { library, storage } = libraryOver();
    await expect(library.update(GLOBAL, draft({ name: "ghost" }))).rejects.toThrow(
      /No skill "ghost" in the global library/,
    );
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("refuses a remove of a skill that is not there, instead of answering done", async () => {
    const { library, storage } = libraryOver();
    await expect(library.remove(GLOBAL, "ghost")).rejects.toThrow(/No skill "ghost"/);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("refuses a rename of a skill that is not there", async () => {
    const { library, storage } = libraryOver();
    await expect(library.rename(GLOBAL, "ghost", "shade")).rejects.toThrow(/No skill "ghost"/);
    expect(storage.rename).not.toHaveBeenCalled();
  });

  it("checks existence in the scope asked for, not any scope", async () => {
    // Both scopes hold a `review`; a workspace-scoped update must not be
    // satisfied by the global one.
    const { library } = libraryOver();
    await expect(
      library.update({ kind: "workspace", wsId: "ws-9" }, draft()),
    ).rejects.toThrow(/No skill "review" in this workspace's library/);
  });

  it("names the scope without an opaque id — no surface shows one", async () => {
    const { library } = libraryOver();
    await expect(library.remove(WS, "ghost")).rejects.toThrow(
      "No skill \"ghost\" in this workspace's library",
    );
  });
});

describe("a rename moves the directory AND fixes the file", () => {
  it("rewrites the frontmatter name, so the two identities agree", async () => {
    // The CLIs read `name:` from the file — that is why compose emits it. A move
    // alone leaves a directory saying one name over a file saying another.
    const { library, storage } = libraryOver({
      fetch: vi
        .fn<() => Promise<StoredSkill[]>>()
        // The pre-move library, then the post-move one the recompose reads.
        .mockResolvedValueOnce(STORED)
        .mockResolvedValue([
          {
            scope: "global",
            wsId: null,
            name: "deep-review",
            content: "---\nname: review\ndescription: Global one\nlicense: MIT\n---\nGlobal body\n",
          },
        ]),
    });

    await library.rename(GLOBAL, "review", "deep-review");

    expect(storage.rename).toHaveBeenCalledWith(GLOBAL, "review", "deep-review");
    const [, name, content] = storage.save.mock.calls[0];
    expect(name).toBe("deep-review");
    const back = parseSkillFile(content);
    expect(back.name).toBe("deep-review");
    // And nothing else about the skill changed.
    expect(back.description).toBe("Global one");
    expect(back.body).toBe("Global body\n");
    expect(back.extraFrontmatter).toEqual(["license: MIT"]);
  });

  it("does not move at all when the new name is invalid", async () => {
    const { library, storage } = libraryOver();
    await expect(library.rename(GLOBAL, "review", "Review Diff")).rejects.toThrow(
      /not a valid skill name/,
    );
    expect(storage.rename).not.toHaveBeenCalled();
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
    await expect(library.rename(GLOBAL, "review", "Review Diff")).rejects.toThrow(
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
