import { describe, expect, it, vi } from "vitest";
import {
  composeSkillFile,
  renameSkillFile,
  skillDraftOf,
  type SkillDraft,
  type SkillScope,
} from "../domain/skills";
import { CARRIED, REFUSED } from "../domain/skills/skills.testSupport";
import {
  createSkillsLibrary,
  type LibrarySkill,
  type SkillsLibrary,
  type SkillsStorage,
} from "./skillsLibrary";

const GLOBAL: SkillScope = { kind: "global" };
const WS: SkillScope = { kind: "workspace", wsId: "ws-1" };

/** One stored row, as the library's own port hands it over — a scope, not the
 * wire's scope-plus-nullable-id columns. */
const row = (scope: SkillScope, name: string, content: string): LibrarySkill => ({
  scope,
  name,
  content,
});

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
const STORED: LibrarySkill[] = [
  row(
    GLOBAL,
    "review",
    "---\nname: review\ndescription: Global one\nlicense: MIT\n---\nGlobal body\n",
  ),
  row(WS, "review", "---\nname: review\ndescription: Workspace one\n---\nWs body\n"),
];

function libraryOver(over: Partial<SkillStorageFakes> = {}) {
  const storage = {
    fetch: vi.fn<() => Promise<LibrarySkill[]>>(async () => STORED),
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

/** The SKILL.md a save was handed, read back the way production reads it —
 * through the projection every surface uses, not the raw codec underneath it. */
const written = (save: { mock: { calls: unknown[][] } }) =>
  skillDraftOf({
    // The (name, content) pair as the storage got it — the projection prefers
    // the directory name, so handing it a blank one would mask the composed one.
    name: save.mock.calls[0]?.[1] as string,
    content: save.mock.calls[0]?.[2] as string,
  });

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
    await library.rename(WS, "review", "deep-review");
    // ONE invalidation for a rename, even though it writes twice (rewrite the
    // frontmatter name, then move) — a rename is one mutation.
    expect(invalidateSkills).toHaveBeenCalledTimes(2);
    await library.remove(WS, "review");
    expect(invalidateSkills).toHaveBeenCalledTimes(3);
  });

  it("invalidates even when the write FAILED, because the disk state is unknown", async () => {
    // Once a call has reached the storage nothing here knows what landed: a
    // compound rename's first step succeeds before its second can fail, and a
    // delete removes children one at a time. A cleared memo costs one re-stage;
    // a memo kept over a library that did change costs every agent the skill.
    const { library, invalidateSkills } = libraryOver({
      save: vi.fn(async () => {
        throw new Error("read-only fs");
      }),
    });
    await expect(library.create(GLOBAL, draft())).rejects.toThrow("read-only fs");
    expect(invalidateSkills).toHaveBeenCalledTimes(1);
  });

  it("does NOT invalidate for a draft it refused, which never reached the disk", async () => {
    // The other half of the rule: composing and every precondition run BEFORE
    // the write, so a refusal is the one case that provably changed nothing.
    const { library, invalidateSkills, storage } = libraryOver();
    await expect(library.create(GLOBAL, draft({ description: " " }))).rejects.toThrow(
      /needs a description/,
    );
    expect(storage.save).not.toHaveBeenCalled();
    expect(invalidateSkills).not.toHaveBeenCalled();
  });

  it("tells its subscribers, so the OTHER door's reader is not left stale", async () => {
    // A view could refresh after its own writes; it could not know about an
    // agent's skills.delete through the command registry.
    const { library } = libraryOver();
    const seen: number[] = [];
    const off = library.subscribe(() => seen.push(1));
    await library.remove(WS, "review");
    expect(seen).toHaveLength(1);
    off();
    await library.remove(WS, "review");
    expect(seen).toHaveLength(1);
  });

  it("survives a subscriber that throws, and still reaches the next one", async () => {
    const { library } = libraryOver();
    let reached = false;
    library.subscribe(() => {
      throw new Error("a view blew up");
    });
    library.subscribe(() => {
      reached = true;
    });
    await library.remove(WS, "review");
    expect(reached).toBe(true);
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

  it("composes the stored file through the domain", async () => {
    const { library, storage } = libraryOver();
    await library.create(GLOBAL, draft());
    const back = written(storage.save);
    expect(back.name).toBe("review");
    expect(back.description).toBe("Use when reviewing a diff");
    expect(back.body).toBe("Read the diff first.\n");
  });

  it("keeps hand-added keys on an UPDATE, and refuses to author them on a create", async () => {
    // Hand-added frontmatter is never authored here, only preserved: `update`
    // re-reads it from disk (STORED's global `review` carries `license: MIT`), so
    // a caller that cannot send those keys back does not eat them and one that
    // captured them earlier cannot write a stale copy over a later hand edit.
    const { library, storage } = libraryOver();
    await library.update(GLOBAL, draft({ extraFrontmatter: ["allowed-tools: Stale"] }));
    expect(written(storage.save).extraFrontmatter).toEqual(["license: MIT"]);

    const fresh = libraryOver();
    await fresh.library.create(GLOBAL, draft({
      name: "deploy",
      extraFrontmatter: ["allowed-tools: Read"],
    }));
    expect(written(fresh.storage.save).extraFrontmatter).toEqual([]);
  });

  it("refuses to re-author frontmatter a recompose could not carry", async () => {
    // An indented mapping is valid YAML that every CLI reads, and composing it
    // would move its lines under the keys we author — which no YAML reader
    // accepts. Refusing keeps the file recoverable; rewriting it did not.
    const { library, storage } = libraryOver({
      fetch: vi.fn(async () => [row(GLOBAL, "review", REFUSED.indentedMapping.content)]),
    });
    // Only that it REFUSES and writes nothing. Which shapes qualify, and in what
    // words, is the domain's — asserting the sentence here made the app layer a
    // second pin for a rule it does not own.
    await expect(library.update(GLOBAL, draft())).rejects.toThrow(/cannot be edited here/);
    expect(storage.save).not.toHaveBeenCalled();
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

  // The workspace wording of that refusal is pinned once, by the scope case
  // above — a third assertion of `describeScope` differing only in the verb said
  // nothing the second did not.
});

describe("a rename moves the directory AND fixes the file", () => {
  it("MOVES before it rewrites the frontmatter name", async () => {
    // ORDER is the point, and it is the storage's collision check that decides it.
    // "Is this name taken" is answered here from the listed rows and there from the
    // DIRECTORY — wider, because a directory with no readable SKILL.md is listed
    // nowhere. Writing the content first let such a target pass our check, land the
    // frontmatter rewrite, and then be refused by the move, leaving the source file
    // declaring the other skill's name with nothing able to repair it: a re-run
    // finds the frontmatter already right and retries only the move, forever.
    const { library, storage } = libraryOver();

    await library.rename(GLOBAL, "review", "deep-review");

    expect(storage.rename).toHaveBeenCalledWith(GLOBAL, "review", "deep-review");
    // Under the NEW name, since the directory has already moved.
    expect(storage.save).toHaveBeenCalledWith(
      GLOBAL,
      "deep-review",
      expect.any(String),
      false,
    );
    expect(storage.rename.mock.invocationCallOrder[0]).toBeLessThan(
      storage.save.mock.invocationCallOrder[0],
    );

    // Through the domain function this layer is supposed to DELEGATE to, rather
    // than a second copy of its byte contract: what belongs here is "rename
    // routes through the splice, not the composer".
    const expected = renameSkillFile(STORED[0].content, "deep-review");
    expect(expected.kind).toBe("rewritten");
    if (expected.kind === "rewritten") {
      expect(storage.save.mock.calls[0][2]).toBe(expected.content);
    }
  });

  it("writes what the SPLICE produced, not what the composer would have", async () => {
    // The bytes are the domain's contract and are pinned there, byte for byte, over
    // this same shape. What belongs at this layer is only that a rename routes
    // through `renameSkillFile` — write the expectation as a literal here and the
    // case still passes on the day the library stops delegating and composes
    // instead, which is the one thing it must not do.
    const content = CARRIED.foldedDescription;
    const { library, storage } = libraryOver({
      fetch: vi.fn(async () => [row(GLOBAL, "review", content)]),
    });

    await library.rename(GLOBAL, "review", "deep-review");

    const spliced = renameSkillFile(content, "deep-review");
    expect(spliced.kind).toBe("rewritten");
    if (spliced.kind === "rewritten") {
      expect(storage.save.mock.calls[0][2]).toBe(spliced.content);
    }
    // And it is NOT what composing would have produced, which is the whole point.
    expect(storage.save.mock.calls[0][2]).not.toBe(
      composeSkillFile(skillDraftOf({ name: "deep-review", content })),
    );
  });

  it("renames a skill this build's authoring rules would refuse, and still WRITES", async () => {
    // A stored skill with no description is legal — nothing outside this editor
    // requires one. Composing it through the authoring gate refused the write
    // AFTER the directory had moved, leaving a two-identity skill no re-run
    // could repair. The fixture deliberately HAS frontmatter with a `name:`, so
    // the write actually happens: over a file with none the splice returns null
    // and the case would pass without ever entering the branch it is about.
    const { library, storage } = libraryOver({
      fetch: vi.fn(async () => [
        row(GLOBAL, "review", "---\nname: review\n---\nJust a body\n"),
      ]),
    });

    await library.rename(GLOBAL, "review", "deep-review");

    expect(storage.save).toHaveBeenCalledWith(
      GLOBAL,
      "deep-review",
      "---\nname: deep-review\n---\nJust a body\n",
      false,
    );
    expect(storage.rename).toHaveBeenCalledWith(GLOBAL, "review", "deep-review");
  });

  it("writes nothing when the file states no name to fix", async () => {
    // With no frontmatter the name comes from the directory and cannot
    // contradict it, so the move IS the whole rename.
    const { library, storage } = libraryOver({
      fetch: vi.fn(async () => [row(GLOBAL, "review", "Just a body\n")]),
    });

    await library.rename(GLOBAL, "review", "deep-review");

    expect(storage.rename).toHaveBeenCalledWith(GLOBAL, "review", "deep-review");
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("reports the library changed when the move fails after the rewrite", async () => {
    // The content write landed, so the staged views are stale whatever happens
    // next. Invalidating only on a fully successful mutation kept yesterday's
    // file for the next spawn.
    const { library, invalidateSkills } = libraryOver({
      rename: vi.fn(async () => {
        throw new Error("cross-device link");
      }),
    });
    await expect(library.rename(GLOBAL, "review", "deep-review")).rejects.toThrow(
      "cross-device link",
    );
    expect(invalidateSkills).toHaveBeenCalledTimes(1);
  });

  it("does not move at all when the new name is invalid", async () => {
    const { library, storage } = libraryOver();
    await expect(library.rename(GLOBAL, "review", "Review Diff")).rejects.toThrow(
      /not a valid skill name/,
    );
    expect(storage.rename).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("refuses a name already taken BEFORE it writes anything", async () => {
    // The storage refuses a taken target too — but only after the frontmatter
    // rewrite has landed in the SOURCE file, which leaves two directories whose
    // SKILL.md both declare the same skill. Nothing repairs that: a re-run finds
    // the frontmatter already correct, so it retries only the move, forever.
    const { library, storage, invalidateSkills } = libraryOver({
      fetch: vi.fn(async () => [
        row(GLOBAL, "review", "---\nname: review\ndescription: d\n---\n"),
        row(GLOBAL, "deploy", "---\nname: deploy\ndescription: d\n---\n"),
      ]),
    });

    await expect(library.rename(GLOBAL, "review", "deploy")).rejects.toThrow(
      '"deploy" is already taken in the global library',
    );

    expect(storage.save).not.toHaveBeenCalled();
    expect(storage.rename).not.toHaveBeenCalled();
    // And no memo cleared for an operation that never happened.
    expect(invalidateSkills).not.toHaveBeenCalled();
  });

  it("refuses renaming a skill to the name it already has", async () => {
    // Reachable from MCP as a re-issued rename. Left to the storage it wrote the
    // frontmatter, then failed on the move — an edit reported as a failure.
    const { library, storage } = libraryOver();
    await expect(library.rename(GLOBAL, "review", "review")).rejects.toThrow(
      /already taken/,
    );
    expect(storage.save).not.toHaveBeenCalled();
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
  // Over the shared STORED library — its two same-named skills in different
  // scopes are exactly what these cases need, and a second copy of those rows
  // would stop widening with it.
  it("returns the draft, keeping hand-added frontmatter", async () => {
    const { library } = libraryOver();
    expect(await library.read(GLOBAL, "review")).toEqual({
      name: "review",
      description: "Global one",
      body: "Global body\n",
      extraFrontmatter: ["license: MIT"],
    });
  });

  it("does not confuse one scope's skill with another's of the same name", async () => {
    const { library } = libraryOver();
    expect((await library.read(WS, "review")).description).toBe("Workspace one");
  });

  it("refuses a skill that scope does not hold, in the words every operation uses", async () => {
    // NOT a null. A nullable read left the one door that needs a refusal to word
    // its own, and the two sentences had already drifted apart.
    const { library } = libraryOver();
    await expect(library.read(GLOBAL, "deploy")).rejects.toThrow(
      'No skill "deploy" in the global library',
    );
    await expect(
      library.read({ kind: "workspace", wsId: "ws-9" }, "review"),
    ).rejects.toThrow("No skill \"review\" in this workspace's library");
  });

  // "The directory name wins over the frontmatter's" is NOT re-tested here: it
  // is `skillDraftOf`'s rule, pinned in the domain suite over the same fixture,
  // and `read` is that function applied to one row. Delegation is what this layer
  // owns, and the case above already shows it.
});

describe("reading the library", () => {
  it("passes the stored list through", async () => {
    const stored = [row(GLOBAL, "a", "---\nname: a\n---\n")];
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
