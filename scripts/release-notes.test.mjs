import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gitRepo } from "./gitRepo.test-support.mjs";
import { buildNotes, changelogLine, parseArgs } from "./release-notes.mjs";

const SCRIPT = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));

describe("parseArgs", () => {
  it("parses everything and defaults previous to empty", () => {
    expect(
      parseArgs(["--version", "1.3.0", "--repo", "o/r", "--out", "notes.md"]),
    ).toEqual({
      version: "1.3.0",
      previous: "",
      repo: "o/r",
      out: "notes.md",
      rolling: false,
    });
  });

  it.each([
    [["--repo", "o/r", "--out", "n"], /--version is required/],
    [["--version", "1.0.0", "--out", "n"], /--repo is required/],
    [["--version", "1.0.0", "--repo", "o/r"], /--out is required/],
    [["--nope"], /unknown argument/],
  ])("rejects bad arguments %j", (argv, error) => {
    expect(() => parseArgs(argv)).toThrow(error);
  });
});

describe("changelogLine", () => {
  it("strips the merge prefix and the release markers", () => {
    expect(changelogLine("Merge: ship the thing (minor)")).toBe("ship the thing");
    expect(changelogLine("Merge: rebuild the core (major) carefully")).toBe(
      "rebuild the core carefully",
    );
    expect(changelogLine("plain subject")).toBe("plain subject");
  });
});

describe("buildNotes", () => {
  it("lists changes between the header and the install one-liner", () => {
    expect(
      buildNotes({ version: "1.3.0", repo: "o/r", changes: ["one", "two"] }),
    ).toBe(
      "KeepDeck 1.3.0.\n\nChanges:\n- one\n- two\n\nInstall:\ncurl -fsSL https://raw.githubusercontent.com/o/r/main/install.sh | sh\n",
    );
  });

  it("omits the section entirely when there is nothing to report", () => {
    const notes = buildNotes({ version: "1.3.0", repo: "o/r", changes: [] });
    expect(notes).not.toContain("Changes:");
    expect(notes).toContain("Install:");
  });

  it("rolling notes are a pointer — no changelog, ever", () => {
    const notes = buildNotes({
      version: "1.3.0",
      repo: "o/r",
      changes: ["one"],
      rolling: true,
    });
    expect(notes).toContain("Rolling release: always the newest build.");
    expect(notes).not.toContain("1.3.0"); // version-free: created once, never edited
    expect(notes).toContain("changelogs live in the releases above");
    expect(notes).not.toContain("Changes:");
    expect(notes).toContain("Install:");
  });
});

/** Run the script in `dir` and read the notes it wrote. */
function run(dir, args) {
  const notes = join(dir, "notes.md");
  rmSync(notes, { force: true });
  execFileSync(process.execPath, [SCRIPT, ...args, "--repo", "o/r", "--out", "notes.md"], {
    cwd: dir,
    encoding: "utf8",
  });
  return readFileSync(notes, "utf8");
}

// One history serves every case: the script only reads it.
describe("the script, run in a real repository", () => {
  let repo;
  beforeAll(() => {
    repo = gitRepo([
      { subject: "init" },
      { subject: "Merge: already released", merge: true },
      { subject: "Bump version to 1.2.0" },
      { subject: "Merge: first change", merge: true },
      { subject: "Merge: second change (minor)", merge: true },
      { subject: "Bump version to 1.3.0" },
    ]);
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("lists every merge since the previous version's bump commit, in merge order", () => {
    const notes = run(repo, ["--version", "1.3.0", "--previous", "1.2.0"]);
    expect(notes).toContain("Changes:\n- first change\n- second change\n\n");
  });

  it("has no changelog for a republish, though merges follow its bump", () => {
    expect(run(repo, ["--version", "1.2.0", "--previous", "1.2.0"])).not.toContain("Changes:");
  });

  it("has no changelog for a first release", () => {
    expect(run(repo, ["--version", "1.0.0"])).not.toContain("Changes:");
  });

  it("degrades to no changelog when the previous bump commit is missing", () => {
    expect(run(repo, ["--version", "1.3.0", "--previous", "9.9.9"])).not.toContain("Changes:");
  });
});

describe("the script, with no repository at all", () => {
  let dir;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes rolling notes, which need no history", () => {
    dir = mkdtempSync(join(tmpdir(), "kd-notes-"));
    const notes = run(dir, ["--version", "1.3.0", "--rolling"]);
    expect(notes).toContain("Rolling release");
    expect(notes).not.toContain("Changes:");
  });
});
