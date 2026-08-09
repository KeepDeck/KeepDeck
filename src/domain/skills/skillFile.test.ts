import { describe, expect, it } from "vitest";
import {
  composeSkillFile,
  frontmatterObstacle,
  parseSkillFile,
  renameSkillFile,
  skillDraftOf,
} from "./skillFile";
import { REFUSED } from "./skills.testSupport";

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
    // The body keeps ITS OWN line endings. Normalizing them here meant every
    // save rewrote every line of a Windows-authored body, for an edit that asked
    // to change one field.
    expect(parsed.body).toBe("Body\r\n");
  });

  it("reads a duplicated key the way its reader resolves it — LAST wins", () => {
    // Not "first", which is what a hand-rolled reader used to take: `yaml` with
    // `uniqueKeys` off — this codec's own configuration — resolves last-wins, and a
    // STRICT reader refuses the mapping outright. Showing the first value meant
    // displaying something no reader uses.
    const stored = "---\nname: x\ndescription: first\ndescription: second\n---\nB\n";
    const parsed = parseSkillFile(stored);
    expect(parsed.description).toBe("second");
    expect(parsed.extraFrontmatter).toEqual([]);
    // And it is refused for WRITING, because there is no value every reader
    // agrees on: picking either would change the file for somebody.
    expect(frontmatterObstacle(stored)).toContain("more than once");
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

describe("a block scalar survives being read and written back", () => {
  // The corruption these exist to keep out: reading only the `>` header left the
  // indented lines in extraFrontmatter, and compose re-emitted them BELOW a
  // finished `description: ">"` entry. That is orphaned indentation — every
  // CLI reads this frontmatter with a real YAML parser, which refuses the whole
  // mapping, so an ordinary "edit the body and save" silently killed the skill.
  const folded = (content: string) => parseSkillFile(content);

  it("reads a folded block scalar as the one line it means", () => {
    const parsed = folded("---\nname: n\ndescription: >\n  Long one,\n  wrapped.\n---\nB\n");
    expect(parsed.description).toBe("Long one, wrapped.");
    // Nothing stranded — this is the whole point.
    expect(parsed.extraFrontmatter).toEqual([]);
  });

  it("reads a literal block scalar, and the chomping and indent indicators", () => {
    for (const header of [">", ">-", "|", "|+", ">2"]) {
      const parsed = folded(`---\ndescription: ${header}\n  a\n  b\n---\n`);
      expect(parsed.description, header).toBe("a b");
      expect(parsed.extraFrontmatter, header).toEqual([]);
    }
  });

  it("ends the block at the next top-level key, keeping it as an extra", () => {
    const parsed = folded(
      "---\nname: n\ndescription: >\n  folded\nallowed-tools: Read\n---\nB\n",
    );
    expect(parsed.description).toBe("folded");
    expect(parsed.extraFrontmatter).toEqual(["allowed-tools: Read"]);
  });

  it("swallows a duplicate's continuation lines rather than stranding them", () => {
    // The value is the LAST one, matching the reader; what matters here is that the
    // shadowed block's indented lines do not survive as extras, where compose
    // would re-emit them below a finished entry.
    const parsed = folded(
      "---\ndescription: first\ndescription: >\n  shadowed\n  lines\n---\nB\n",
    );
    expect(parsed.description).toBe("shadowed lines");
    expect(parsed.extraFrontmatter).toEqual([]);
  });

  it("leaves an extra key's OWN block scalar alone, so a save keeps it", () => {
    const content = "---\nname: n\ndescription: d\nallowed-tools: >\n  Read\n  Write\n---\nB\n";
    const parsed = folded(content);
    // ONE chunk per entry, its verbatim source — not a line each. An entry is
    // what has to stay together to still mean the same thing; splitting it into
    // lines was how a continuation line ended up somewhere else.
    expect(parsed.extraFrontmatter).toEqual(["allowed-tools: >\n  Read\n  Write"]);
    // It re-composes in place, still valid: the indented run follows the key it
    // belongs to, which compose emitted just above it.
    expect(composeSkillFile({ ...parsed, name: "n" })).toBe(content);
  });

  it("names the offending KEY in its reason, not just the shape", () => {
    // Only the sentence is this suite's: WHICH shapes qualify is the verdict table
    // in `skillFileYaml.test.ts`, checked there against a real reader. Pinning the
    // table in both files meant rewording one arm broke four sites in three files.
    // What has to hold here is that the reason can be shown to a user, which for
    // the commonest case means naming the line they have to go and fix.
    expect(frontmatterObstacle(REFUSED.indentedMapping.content)).toContain(
      '"name" is indented',
    );
  });
});

/** The rewritten file, for a rename that was expected to produce one. */
const renamedTo = (content: string, name: string): string => {
  const result = renameSkillFile(content, name);
  if (result.kind !== "rewritten") throw new Error(`expected a rewrite, got ${result.kind}`);
  return result.content;
};

describe("renaming a stored file", () => {
  it("moves the name onto the new one and touches nothing else", () => {
    expect(
      renamedTo(
        "---\nname: review\ndescription: Reviews a diff\nlicense: MIT\n---\nBody\n",
        "deep-review",
      ),
    ).toBe("---\nname: deep-review\ndescription: Reviews a diff\nlicense: MIT\n---\nBody\n");
  });

  it("carries a block scalar byte for byte, where composing only keeps its meaning", () => {
    // THE case this exists for. A block scalar is valid YAML, and a rename
    // authors nothing, so the stored bytes must come back untouched.
    const content =
      "---\nname: review\ndescription: >\n  Long one,\n  wrapped.\n---\nBody\n";
    expect(renamedTo(content, "deep-review")).toBe(
      "---\nname: deep-review\ndescription: >\n  Long one,\n  wrapped.\n---\nBody\n",
    );
    // And composing the same file — which is what an UPDATE does — no longer
    // destroys it: the value survives folded onto its one line, with nothing
    // stranded below a finished entry. It used to come back as the literal ">"
    // followed by orphaned indentation, which no YAML reader accepts.
    // (Quoted because the folded value contains a comma — `scalar`'s ordinary
    // job, and it reads back as the same string.)
    expect(composeSkillFile(skillDraftOf({ name: "deep-review", content }))).toBe(
      '---\nname: deep-review\ndescription: "Long one, wrapped."\n---\nBody\n',
    );
  });

  it("keeps CRLF line endings as they were", () => {
    // A hand-edited Windows file must come back editable, not with every line
    // ending rewritten by an operation that was asked to change one word.
    expect(
      renamedTo("---\r\nname: review\r\ndescription: d\r\n---\r\nBody\r\n", "deep"),
    ).toBe("---\r\nname: deep\r\ndescription: d\r\n---\r\nBody\r\n");
  });

  it("quotes the new name only when YAML would misread it plain", () => {
    // Through the same scalar rule compose uses — one answer to "how does a
    // value go onto a frontmatter line", or a round trip would read back a
    // different name than the one written.
    expect(renamedTo("---\nname: a\n---\n", "no")).toBe('---\nname: "no"\n---\n');
  });

  it("answers `unchanged` when there is nothing to rewrite", () => {
    // Each of these takes its name from the DIRECTORY, so it cannot disagree
    // with it and the rename is the move alone — the library skips the write.
    for (const content of [
      "Just a body\n",
      "---\ndescription: d\n---\nBody\n",
      "---\nname: deep\ndescription: d\n---\n",
    ]) {
      expect(renameSkillFile(content, "deep"), content).toEqual({ kind: "unchanged" });
    }
  });

  it("REFUSES a file whose stated name it cannot restate", () => {
    // Answering "nothing to rewrite" here moved the directory and left the file
    // naming the old skill — the two-identity state the rename exists to prevent.
    const indented = renameSkillFile("---\n  name: old\n  description: d\n---\nB\n", "new");
    expect(indented.kind).toBe("unsupported");
    if (indented.kind === "unsupported") expect(indented.reason).toContain("indented");
  });

  it("re-composes when the name is real but not one line to splice", () => {
    // A block-scalar name cannot be fixed by rewriting its header — that strands
    // the old value underneath — but the file is one we can re-emit, so it is
    // rewritten whole rather than refused.
    expect(renamedTo("---\nname: >\n  old\ndescription: d\n---\nB\n", "new")).toBe(
      "---\nname: new\ndescription: d\n---\nB\n",
    );
  });

  it("REFUSES a file that states its name twice", () => {
    // It used to splice the first line and report success while the file still said
    // `name: b` to a last-wins reader — the two-identity state a rename exists to
    // remove, created by the rename itself.
    const twice = renameSkillFile("---\nname: a\nname: b\n---\n", "c");
    expect(twice.kind).toBe("unsupported");
    if (twice.kind === "unsupported") expect(twice.reason).toContain("more than once");
  });

  it("does not mistake a `name:` line in the BODY for the frontmatter's", () => {
    expect(renamedTo("---\nname: review\n---\nname: not-frontmatter\n", "deep")).toBe(
      "---\nname: deep\n---\nname: not-frontmatter\n",
    );
  });
});
