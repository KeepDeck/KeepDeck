import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  composeSkillFile,
  frontmatterObstacle,
  parseSkillFile,
  renameSkillFile,
} from "./skillFile";

/**
 * The codec against a REAL YAML reader, which is what every supported CLI reads
 * a stored SKILL.md with.
 *
 * Its own suite because the assertion is different in kind from the rest: not
 * "the bytes are what we expect" but "what a YAML parser sees is still right
 * after we touch the file". Three review rounds of hand-rolled reading each
 * looked self-consistent and each silently destroyed a shape it did not model —
 * a block scalar, then a block scalar with a comment, then a quoted key. This is
 * the gate that catches that class, so every shape those rounds turned up lives
 * here as a case.
 *
 * The rule under test, for any stored file: EITHER we refuse to touch it, OR a
 * YAML reader still reads the same `name` and `description` afterwards.
 */

/** The frontmatter text, read the way the codec locates it. */
function frontmatterText(file: string): string | null {
  const match = /^---[ \t]*\r?\n([\s\S]*?)(?:^|\n)---[ \t]*(?:\r?\n|$)/.exec(file);
  return match ? match[1] : null;
}

/** What a real YAML reader makes of a stored file's frontmatter. */
function asRead(file: string): Record<string, unknown> | "invalid" | "none" {
  const text = frontmatterText(file);
  if (text === null) return "none";
  try {
    const value: unknown = parse(text);
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return "invalid";
  }
}

const oneLine = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

/** Every stored shape the reviews turned up, valid YAML in all cases. */
const STORED: Record<string, string> = {
  "a plain file KeepDeck itself writes":
    "---\nname: review\ndescription: Reviews a diff\nlicense: MIT\n---\nBody\n",
  "a folded block-scalar description":
    "---\nname: review\ndescription: >\n  Long one,\n  wrapped.\nlicense: MIT\n---\nBody\n",
  "a block-scalar header carrying a comment":
    "---\nlicense: MIT\nname: demo\ndescription: >- # short\n  one\n  two\n---\nBody\n",
  "a block scalar whose indicators are the other way round":
    "---\nname: demo\ndescription: >2-\n  one\n  two\n---\nBody\n",
  "a literal block-scalar description":
    "---\nname: demo\ndescription: |\n  step one\n  step two\n---\nBody\n",
  "a block-scalar NAME":
    "---\nname: >\n  old-skill\ndescription: Reviews\n---\nBody\n",
  "a quoted multi-line description":
    '---\nlicense: MIT\nname: a\ndescription: "one\n  two"\n---\nbody\n',
  "a plain multi-line description":
    "---\nlicense: MIT\nname: a\ndescription: one\n  two\n---\nbody\n",
  "a quoted key spelling":
    '---\n"name": review\ndescription: d\n---\nBody\n',
  "a spaced key spelling":
    "---\nname : review\ndescription: d\n---\nBody\n",
  "a description with a trailing comment":
    "---\nname: demo\ndescription: Reviews a diff # keep short\n---\nB\n",
  "a description with an escape":
    '---\nname: demo\ndescription: "caf\\u00e9 au lait"\n---\nB\n',
  "a name with a trailing comment":
    "---\nname: old # the id\ndescription: d\n---\nbody\n",
  "an indented comment among the keys":
    "---\nname: demo\ndescription: d\n  # a note\n---\nBody\n",
  "an extra key with its own block scalar":
    "---\nname: n\ndescription: d\nallowed-tools: >\n  Read\n  Write\n---\nB\n",
  "a fence with trailing spaces":
    "---\nname: demo\ndescription: Reviews\n---  \nBody\n",
  "an entirely indented mapping":
    "---\n  name: old-skill\n  description: d\n---\nBody\n",
  "a CRLF file":
    "---\r\nname: demo\r\ndescription: Reviews\r\n---\r\nBody\r\n",
};

describe("what a YAML reader sees after we rewrite a stored skill", () => {
  for (const [label, stored] of Object.entries(STORED)) {
    it(`preserves name and description through an update: ${label}`, () => {
      const before = asRead(stored);
      expect(before, "the fixture must be valid YAML to be worth testing").not.toBe(
        "invalid",
      );

      const obstacle = frontmatterObstacle(stored);
      if (obstacle !== null) {
        // Refusing is a correct answer — but only refusing, never a half-rewrite.
        expect(obstacle).toMatch(/\S/);
        return;
      }

      // What an update writes: the caller's name/description/body, the stored
      // extras carried over — which is exactly what `SkillsLibrary.update` does.
      const draft = parseSkillFile(stored);
      const written = composeSkillFile({ ...draft, name: draft.name ?? "on-disk" });
      const after = asRead(written);

      expect(after, "we must never write frontmatter a YAML reader refuses").not.toBe(
        "invalid",
      );
      if (before === "none" || after === "none" || before === "invalid" || after === "invalid") {
        throw new Error("unreachable: guarded above");
      }
      // The DIRECTORY name wins by design, so compare the description, and the
      // name only when the file stated one.
      expect(oneLine(after.description), "description").toBe(oneLine(before.description));
      if (before.name !== undefined) {
        expect(oneLine(after.name), "name").toBe(oneLine(draft.name ?? ""));
      }
    });

    it(`renames without changing what else the file says: ${label}`, () => {
      const before = asRead(stored);
      const renamed = renameSkillFile(stored, "new-name");

      if (renamed.kind === "unsupported") {
        expect(renamed.reason).toMatch(/\S/);
        return;
      }
      if (renamed.kind === "unchanged") {
        // Only legitimate when the file states no name of its own — otherwise the
        // directory moves and the file keeps contradicting it.
        expect(before === "none" ? undefined : (before as Record<string, unknown>).name)
          .toBeUndefined();
        return;
      }

      const after = asRead(renamed.content);
      expect(after, "a rename must never produce frontmatter a reader refuses").not.toBe(
        "invalid",
      );
      if (before === "none" || after === "none" || before === "invalid" || after === "invalid") {
        throw new Error("unreachable: guarded above");
      }
      expect(oneLine(after.name), "the new name").toBe("new-name");
      // Everything else survives, description and hand-added keys alike.
      expect(oneLine(after.description), "description").toBe(oneLine(before.description));
      for (const key of Object.keys(before)) {
        if (key === "name") continue;
        expect(oneLine(after[key]), key).toBe(oneLine(before[key]));
      }
    });
  }

  it("refuses rather than rewrites, for every shape it cannot restate", () => {
    // The two the reviews found: frontmatter that is one indented mapping, and
    // frontmatter that is not a mapping at all.
    expect(frontmatterObstacle("---\n  name: a\n  description: d\n---\nB\n")).toContain(
      "indented",
    );
    expect(frontmatterObstacle("---\n- just\n- a list\n---\nB\n")).toContain(
      "not a list of keys",
    );
    expect(frontmatterObstacle("---\nname: [unclosed\n---\nB\n")).toContain("not valid YAML");
    // And the ordinary shapes stay editable.
    expect(frontmatterObstacle("---\nname: a\ndescription: d\n---\nB\n")).toBeNull();
    expect(frontmatterObstacle("Just a body\n")).toBeNull();
  });
});
