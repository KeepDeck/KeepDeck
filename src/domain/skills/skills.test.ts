import { describe, expect, it } from "vitest";
import {
  composeSkillFile,
  isValidSkillName,
  normalizeSkillDescription,
  parseSkillFile,
  renameSkillFile,
  sameSkillScope,
  skillDescriptionProblem,
  skillDraftOf,
  skillScopeOf,
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

  it("keeps the FIRST duplicated key and DROPS the shadowed one", () => {
    // Keeping the duplicate used to look like "nothing is ever lost", but
    // compose emits the extras AFTER the authoritative lines, so a save put the
    // stale value last — and a real YAML parser (which is what every CLI uses
    // here) takes the last duplicate or refuses the mapping. One save therefore
    // promoted the value the author had just replaced.
    const stored = "---\nname: x\ndescription: first\ndescription: second\n---\nB\n";
    const parsed = parseSkillFile(stored);
    expect(parsed.description).toBe("first");
    expect(parsed.extraFrontmatter).toEqual([]);

    const saved = composeSkillFile({ ...parsed, name: "x" });
    expect(saved).toContain("description: first");
    expect(saved).not.toContain("description: second");
    // And the result is now a fixed point for a last-wins parser too.
    expect(parseSkillFile(saved).description).toBe("first");
  });

  it("still keeps frontmatter keys it does not own", () => {
    const parsed = parseSkillFile(
      "---\nname: x\ndescription: d\nallowed-tools: Read\nlicense: MIT\n---\nB\n",
    );
    expect(parsed.extraFrontmatter).toEqual(["allowed-tools: Read", "license: MIT"]);
  });

  it("skillDraftOf lets the directory name win over the file's", () => {
    // Every CLI keys on the directory, and a hand edit can leave the two apart.
    const draft = skillDraftOf({
      name: "on-disk",
      content: "---\nname: stale-in-file\ndescription: d\n---\nB\n",
    });
    expect(draft).toEqual({
      name: "on-disk",
      description: "d",
      body: "B\n",
      extraFrontmatter: [],
    });
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

describe("renaming a stored file", () => {
  it("moves the name onto the new one and touches nothing else", () => {
    expect(
      renameSkillFile(
        "---\nname: review\ndescription: Reviews a diff\nlicense: MIT\n---\nBody\n",
        "deep-review",
      ),
    ).toBe("---\nname: deep-review\ndescription: Reviews a diff\nlicense: MIT\n---\nBody\n");
  });

  it("carries frontmatter the composer cannot, byte for byte", () => {
    // THE case this exists for. A block scalar is valid YAML that the
    // parse/compose round trip loses: `description: >` reads back as the literal
    // ">" and its continuation lines return below the quoted scalar, which is
    // frontmatter no YAML parser accepts — and a YAML parser is what every CLI
    // reads this file with. Renaming must not be able to break a working skill.
    const content =
      "---\nname: review\ndescription: >\n  Long one,\n  wrapped.\n---\nBody\n";
    expect(renameSkillFile(content, "deep-review")).toBe(
      "---\nname: deep-review\ndescription: >\n  Long one,\n  wrapped.\n---\nBody\n",
    );
    // Proof the round trip is not an option here, not just a worse one.
    expect(composeSkillFile(skillDraftOf({ name: "deep-review", content }))).toContain(
      'description: ">"',
    );
  });

  it("keeps CRLF line endings as they were", () => {
    // A hand-edited Windows file must come back editable, not with every line
    // ending rewritten by an operation that was asked to change one word.
    expect(
      renameSkillFile("---\r\nname: review\r\ndescription: d\r\n---\r\nBody\r\n", "deep"),
    ).toBe("---\r\nname: deep\r\ndescription: d\r\n---\r\nBody\r\n");
  });

  it("quotes the new name only when YAML would misread it plain", () => {
    // Through the same scalar rule compose uses — one answer to "how does a
    // value go onto a frontmatter line", or a round trip would read back a
    // different name than the one written.
    expect(renameSkillFile("---\nname: a\n---\n", "no")).toBe('---\nname: "no"\n---\n');
  });

  it("answers null when there is nothing to rewrite", () => {
    // Each of these takes its name from the DIRECTORY, so it cannot disagree
    // with it and the rename is the move alone — the library skips the write.
    expect(renameSkillFile("Just a body\n", "deep")).toBeNull();
    expect(renameSkillFile("---\ndescription: d\n---\nBody\n", "deep")).toBeNull();
    expect(renameSkillFile("---\nname: deep\ndescription: d\n---\n", "deep")).toBeNull();
  });

  it("rewrites the first name line, the one the parser reads", () => {
    // A later duplicate is a line `parseSkillFile` already drops; rewriting it
    // instead would move the name the readers ignore.
    expect(renameSkillFile("---\nname: a\nname: b\n---\n", "c")).toBe(
      "---\nname: c\nname: b\n---\n",
    );
  });

  it("does not mistake a `name:` line in the BODY for the frontmatter's", () => {
    const content = "---\nname: review\n---\nname: not-frontmatter\n";
    expect(renameSkillFile(content, "deep")).toBe(
      "---\nname: deep\n---\nname: not-frontmatter\n",
    );
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
