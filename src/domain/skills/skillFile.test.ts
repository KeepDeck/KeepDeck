import { describe, expect, it } from "vitest";
import {
  composeSkillFile,
  orphanedFrontmatterLine,
  parseSkillFile,
  renameSkillFile,
  skillDraftOf,
} from "./skillFile";

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

  it("swallows a LATER duplicate's continuation lines too", () => {
    // The kept value is the first one; the shadowed block must not be left
    // behind as extras, or it comes back below the composed keys.
    const parsed = folded(
      "---\ndescription: first\ndescription: >\n  shadowed\n  lines\n---\nB\n",
    );
    expect(parsed.description).toBe("first");
    expect(parsed.extraFrontmatter).toEqual([]);
  });

  it("leaves an extra key's OWN block scalar alone, so a save keeps it", () => {
    const content = "---\nname: n\ndescription: d\nallowed-tools: >\n  Read\n  Write\n---\nB\n";
    const parsed = folded(content);
    expect(parsed.extraFrontmatter).toEqual(["allowed-tools: >", "  Read", "  Write"]);
    // It re-composes in place, still valid: the indented run follows the key it
    // belongs to, which compose emitted just above it.
    expect(composeSkillFile({ ...parsed, name: "n" })).toBe(content);
  });

  it("names an extra that a recompose could NOT carry", () => {
    // Frontmatter written as an indented mapping: valid YAML, and every line
    // lands in extras, so composing would put them under the keys we author.
    expect(orphanedFrontmatterLine(["  name: review", "  description: d"])).toBe(
      "  name: review",
    );
    expect(orphanedFrontmatterLine(["- item"])).toBe("- item");
    // An indented run LATER is a continuation of an extra key above it.
    expect(orphanedFrontmatterLine(["allowed-tools: >", "  Read"])).toBeNull();
    expect(orphanedFrontmatterLine(["license: MIT"])).toBeNull();
    expect(orphanedFrontmatterLine([])).toBeNull();
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

  it("carries a block scalar byte for byte, where composing only keeps its meaning", () => {
    // THE case this exists for. A block scalar is valid YAML, and a rename
    // authors nothing, so the stored bytes must come back untouched.
    const content =
      "---\nname: review\ndescription: >\n  Long one,\n  wrapped.\n---\nBody\n";
    expect(renameSkillFile(content, "deep-review")).toBe(
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
