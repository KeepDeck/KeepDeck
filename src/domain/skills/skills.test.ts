import { describe, expect, it } from "vitest";
import {
  normalizeSkillDescription,
  sameSkillScope,
  skillDescriptionProblem,
  skillNameProblem,
  skillScopeOf,
} from "./skills";

describe("skill names", () => {
  it("accepts kebab-case and rejects everything path-like or shouty", () => {
    for (const good of ["review", "deep-review", "a", "x2", "a-1-b"]) {
      expect(skillNameProblem(good), good).toBeNull();
    }
    for (const bad of ["Review", "a b", "a/b", "../up", "-lead", "trail-", "a".repeat(65)]) {
      expect(skillNameProblem(bad), bad).toBe("invalid");
    }
  });

  it("separates a name that is EMPTY from one that is wrong", () => {
    // The distinction the editor could not make with a boolean: an emptied field
    // disabled Save while the charset message stayed hidden, because "nothing
    // typed yet" and "typed something illegal" were one value.
    expect(skillNameProblem("")).toBe("empty");
    expect(skillNameProblem("   ")).toBe("empty");
    expect(skillNameProblem("My_Skill")).toBe("invalid");
  });

  it("names what is wrong with a description, in one verdict", () => {
    expect(skillDescriptionProblem("one line")).toBeNull();
    expect(skillDescriptionProblem("two\nlines")).toBe("multiline");
    // Empty is a problem, not merely unhelpful: agents select on the
    // description, and some drop a skill that has none.
    expect(skillDescriptionProblem("")).toBe("empty");
    expect(skillDescriptionProblem("   ")).toBe("empty");
    // Empty is reported BEFORE multiline, so a blank-but-multiline paste reads
    // as the thing the author has to fix.
    expect(skillDescriptionProblem(" \n ")).toBe("empty");
  });

  it("folds pasted newlines onto the one-line contract", () => {
    // Untouched when already one line — including inner runs of spaces.
    expect(normalizeSkillDescription("one  plain line ")).toBe("one  plain line ");
    // A newline run and the indentation around it become ONE space; CRLF
    // pastes and blank lines collapse the same way.
    expect(normalizeSkillDescription("first\nsecond")).toBe("first second");
    expect(normalizeSkillDescription("first  \r\n   second")).toBe("first second");
    expect(normalizeSkillDescription("first\n\n\nsecond")).toBe("first second");
    // The result always satisfies the verdict it exists to serve.
    expect(skillDescriptionProblem(normalizeSkillDescription("a\nb\r\nc"))).toBeNull();
  });
});

describe("skill scopes", () => {
  it("tells the global library from a workspace's", () => {
    expect(sameSkillScope({ kind: "global" }, { kind: "global" })).toBe(true);
    expect(sameSkillScope({ kind: "global" }, { kind: "workspace", wsId: "ws-1" })).toBe(
      false,
    );
  });

  it("separates two workspaces", () => {
    const first = { kind: "workspace", wsId: "ws-1" } as const;
    expect(sameSkillScope(first, { kind: "workspace", wsId: "ws-1" })).toBe(true);
    expect(sameSkillScope(first, { kind: "workspace", wsId: "ws-2" })).toBe(false);
  });

  it("reads a stored row's scope", () => {
    expect(skillScopeOf({ scope: "global", wsId: null })).toEqual({ kind: "global" });
    expect(skillScopeOf({ scope: "workspace", wsId: "ws-3" })).toEqual({
      kind: "workspace",
      wsId: "ws-3",
    });
  });

  it("keeps a malformed workspace row out of every real workspace", () => {
    // A row that claims a workspace but names none is broken, not global:
    // reading it as global would show it in the global library, and the empty
    // id matches no live workspace, which is where it belongs until fixed.
    const orphan = skillScopeOf({ scope: "workspace", wsId: null });
    expect(orphan).toEqual({ kind: "workspace", wsId: "" });
    expect(sameSkillScope(orphan, { kind: "global" })).toBe(false);
    expect(sameSkillScope(orphan, { kind: "workspace", wsId: "ws-1" })).toBe(false);
  });
});
