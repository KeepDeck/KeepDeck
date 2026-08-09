import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  composeSkillFile,
  frontmatterObstacle,
  frontmatterTextOf,
  parseSkillFile,
  renameSkillFile,
} from "./skillFile";
import { CARRIED, REFUSED } from "./skills.testSupport";

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

/** What a real YAML reader makes of a stored file's frontmatter.
 *
 * The fence is located by the CODEC (`frontmatterTextOf`), deliberately — a
 * regex of our own here was a third hand-rolled reader in the very file written
 * because hand-rolled readers kept being nearly right, and it already disagreed
 * with production on an empty fenced block, which made those cases pass
 * vacuously. What must stay independent is the PARSE below. */
function asRead(file: string): Record<string, unknown> | "invalid" | "none" {
  const text = frontmatterTextOf(file);
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

describe("what a YAML reader sees after we rewrite a stored skill", () => {
  for (const [label, stored] of Object.entries(CARRIED)) {
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
      // And EVERY OTHER KEY, which is the half this suite used to leave to the
      // rename cases — where 17 of 18 fixtures take the byte-preserving splice and
      // never reach the composer at all. A mangled extras splice would have shipped.
      for (const key of Object.keys(before)) {
        if (key === "name" || key === "description") continue;
        expect(oneLine(after[key]), key).toBe(oneLine(before[key]));
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

  it("refuses a duplicated key that a STRICT reader refuses outright", () => {
    // Not in the table above, because the table's premise is "valid YAML" and this
    // is the one shape where readers disagree about that: `yaml`'s default refuses
    // the mapping, and with `uniqueKeys` off it resolves LAST-wins. There is no
    // value we could write that is right for both, so we write nothing — and we
    // show the one a lenient reader uses, since that is what the agents get.
    const stored = "---\nname: demo\ndescription: first\ndescription: second\n---\nBody\n";
    expect(asRead(stored), "a strict reader").toBe("invalid");
    expect(frontmatterObstacle(stored)).toContain("more than once");
    expect(parseSkillFile(stored).description).toBe("second");
  });

  // THE verdict table: which shapes we refuse to author over, and why. It lives
  // here and not in `skillFile.test.ts`, which owns the SENTENCE — pinning both in
  // both files meant rewording one arm broke four sites in three files, one of them
  // an app-layer regex for a rule the app layer does not own.
  for (const [label, { content, because }] of Object.entries(REFUSED)) {
    it(`refuses to author over ${label}, naming why`, () => {
      expect(frontmatterObstacle(content)).toContain(because);
      // And a rename refuses too, rather than moving the directory and leaving the
      // file behind: the two must agree about what is beyond us.
      expect(renameSkillFile(content, "new-name").kind).toBe("unsupported");
    });
  }

  it("leaves the ordinary shapes editable", () => {
    expect(frontmatterObstacle(CARRIED.plain)).toBeNull();
    expect(frontmatterObstacle("Just a body\n")).toBeNull();
    expect(frontmatterObstacle("---\n---\nB\n")).toBeNull();
    expect(frontmatterObstacle("---\n# only a note\n---\nB\n")).toBeNull();
  });
});
