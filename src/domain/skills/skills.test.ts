import { describe, expect, it } from "vitest";
import {
  composeSkillFile,
  isValidSkillDescription,
  isValidSkillName,
  normalizeSkillDescription,
  parseSkillFile,
} from "./skills";

describe("skill names", () => {
  it("accepts kebab-case and rejects everything path-like or shouty", () => {
    for (const good of ["review", "deep-review", "a", "x2", "a-1-b"]) {
      expect(isValidSkillName(good), good).toBe(true);
    }
    for (const bad of ["", "Review", "a b", "a/b", "../up", "-lead", "trail-", "a".repeat(65)]) {
      expect(isValidSkillName(bad), bad).toBe(false);
    }
  });

  it("keeps descriptions single-line", () => {
    expect(isValidSkillDescription("one line")).toBe(true);
    expect(isValidSkillDescription("two\nlines")).toBe(false);
  });

  it("folds pasted newlines onto the one-line contract", () => {
    // Untouched when already one line — including inner runs of spaces.
    expect(normalizeSkillDescription("one  plain line ")).toBe("one  plain line ");
    // A newline run and the indentation around it become ONE space; CRLF
    // pastes and blank lines collapse the same way.
    expect(normalizeSkillDescription("first\nsecond")).toBe("first second");
    expect(normalizeSkillDescription("first  \r\n   second")).toBe("first second");
    expect(normalizeSkillDescription("first\n\n\nsecond")).toBe("first second");
    // The result always satisfies the validator it exists to serve.
    expect(isValidSkillDescription(normalizeSkillDescription("a\nb\r\nc"))).toBe(true);
  });
});

describe("compose/parse round-trip", () => {
  it("round-trips a plain skill", () => {
    const file = composeSkillFile({
      name: "deep-review",
      description: "Reviews the current diff",
      body: "Do the review.\n",
      extraFrontmatter: [],
    });
    expect(file).toBe(
      "---\nname: deep-review\ndescription: Reviews the current diff\n---\nDo the review.\n",
    );
    const parsed = parseSkillFile(file);
    expect(parsed.name).toBe("deep-review");
    expect(parsed.description).toBe("Reviews the current diff");
    expect(parsed.body).toBe("Do the review.\n");
  });

  it("quotes risky descriptions and reads them back", () => {
    for (const description of [
      "Use when: always",
      'He said "go"',
      "50% of the time #always",
      "back\\slash",
      "",
    ]) {
      const file = composeSkillFile({
        name: "x",
        description,
        body: "b",
        extraFrontmatter: [],
      });
      expect(parseSkillFile(file).description, description).toBe(description);
    }
  });

  it("quotes YAML-reserved and numeric-looking scalars so real parsers keep strings", () => {
    // Our regex round-trip can't tell — but the CLIs parse this frontmatter
    // with real YAML parsers, where bare true/null/123 stop being strings.
    for (const value of [
      "true",
      "False",
      "null",
      "~",
      "123",
      "3.14",
      "-5",
      "1e3",
      "no",
      "0x1F",
      "0o7",
      ".inf",
      ".nan",
      "+.inf",
    ]) {
      const file = composeSkillFile({
        name: "x",
        description: value,
        body: "b",
        extraFrontmatter: [],
      });
      expect(file, value).toContain(`description: "${value}"`);
      expect(parseSkillFile(file).description, value).toBe(value);
    }
    // An ordinary sentence stays unquoted — no needless churn.
    const plain = composeSkillFile({
      name: "x",
      description: "Ships the release",
      body: "b",
      extraFrontmatter: [],
    });
    expect(plain).toContain("description: Ships the release");
  });

  it("preserves hand-added frontmatter lines a form save must not eat", () => {
    const stored =
      "---\nname: deploy\ndescription: Ships it\nallowed-tools: Bash\nlicense: MIT\n---\nBody\n";
    const parsed = parseSkillFile(stored);
    expect(parsed.extraFrontmatter).toEqual(["allowed-tools: Bash", "license: MIT"]);
    const saved = composeSkillFile({
      name: "deploy",
      description: "Ships it faster",
      body: parsed.body,
      extraFrontmatter: parsed.extraFrontmatter,
    });
    expect(saved).toContain("allowed-tools: Bash");
    expect(saved).toContain("license: MIT");
    expect(saved).toContain("description: Ships it faster");
  });

  it("parses a CRLF-authored file instead of demoting its frontmatter", () => {
    const stored =
      "---\r\nname: deploy\r\ndescription: Ships it\r\nallowed-tools: Bash\r\n---\r\nBody\r\n";
    const parsed = parseSkillFile(stored);
    expect(parsed.name).toBe("deploy");
    expect(parsed.description).toBe("Ships it");
    expect(parsed.extraFrontmatter).toEqual(["allowed-tools: Bash"]);
    expect(parsed.body).toBe("Body\n");
  });

  it("keeps the FIRST duplicated key and preserves the rest verbatim", () => {
    const stored = "---\nname: x\ndescription: first\ndescription: second\n---\nB\n";
    const parsed = parseSkillFile(stored);
    expect(parsed.description).toBe("first");
    expect(parsed.extraFrontmatter).toEqual(["description: second"]);
    // A form save re-emits the duplicate — hand-added lines are never lost.
    const saved = composeSkillFile({
      name: "x",
      description: parsed.description,
      body: parsed.body,
      extraFrontmatter: parsed.extraFrontmatter,
    });
    expect(saved).toContain("description: first");
    expect(saved).toContain("description: second");
  });

  it("treats a file without frontmatter as body-only", () => {
    const parsed = parseSkillFile("Just instructions.\n");
    expect(parsed.name).toBeNull();
    expect(parsed.description).toBe("");
    expect(parsed.body).toBe("Just instructions.\n");
  });

  it("treats an unclosed frontmatter fence as body-only", () => {
    const parsed = parseSkillFile("---\nname: broken\n");
    expect(parsed.name).toBeNull();
    expect(parsed.body).toBe("---\nname: broken\n");
  });

  it("appends a trailing newline to a body that lacks one", () => {
    const file = composeSkillFile({
      name: "x",
      description: "d",
      body: "no newline",
      extraFrontmatter: [],
    });
    expect(file.endsWith("no newline\n")).toBe(true);
  });
});
