import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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

describe("end to end in a real repo", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function repo() {
    dir = mkdtempSync(join(tmpdir(), "kd-notes-"));
    const git = (...args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    const commit = (msg) => {
      writeFileSync(join(dir, "f.txt"), msg);
      git("add", "f.txt");
      git("commit", "-qm", msg);
    };
    const merge = (msg) => {
      git("checkout", "-qb", "feat");
      commit(`work for: ${msg}`);
      git("checkout", "-q", "main");
      git("merge", "--no-ff", "-q", "-m", msg, "feat");
      git("branch", "-qD", "feat");
    };
    return { git, commit, merge };
  }

  function run(args) {
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
    return readFileSync(join(dir, "notes.md"), "utf8");
  }

  it("reports every merge since the previous version's bump commit", () => {
    const { commit, merge } = repo();
    commit("init");
    commit("Bump version to 1.2.0");
    merge("Merge: first change");
    merge("Merge: second change (minor)");
    commit("Bump version to 1.3.0");

    const notes = run([
      "--version", "1.3.0", "--previous", "1.2.0",
      "--repo", "o/r", "--out", "notes.md",
    ]);
    expect(notes).toContain("- first change");
    expect(notes).toContain("- second change");
    expect(notes).not.toContain("(minor)");
  });

  it("degrades to no changelog for a first release or a republish", () => {
    const { commit, merge } = repo();
    commit("init");
    merge("Merge: some change");

    const first = run(["--version", "1.0.0", "--repo", "o/r", "--out", "notes.md"]);
    expect(first).not.toContain("Changes:");

    const republish = run([
      "--version", "1.0.0", "--previous", "1.0.0",
      "--repo", "o/r", "--out", "notes.md",
    ]);
    expect(republish).not.toContain("Changes:");
  });

  it("writes rolling notes without touching git at all", () => {
    dir = mkdtempSync(join(tmpdir(), "kd-notes-"));
    // No `git init`: rolling notes must not need history.
    const notes = run([
      "--version", "1.3.0", "--rolling",
      "--repo", "o/r", "--out", "notes.md",
    ]);
    expect(notes).toContain("Rolling release");
    expect(notes).not.toContain("Changes:");
  });

  it("degrades gracefully when the previous bump commit is missing", () => {
    const { commit, merge } = repo();
    commit("init");
    merge("Merge: some change");

    const notes = run([
      "--version", "1.3.0", "--previous", "9.9.9",
      "--repo", "o/r", "--out", "notes.md",
    ]);
    expect(notes).not.toContain("Changes:");
  });
});
