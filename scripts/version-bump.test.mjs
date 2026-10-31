import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  bumpVersion,
  classifyMergeSubject,
  computeNext,
  parseCargoVersion,
  planBump,
  readBumpArg,
  setCargoVersion,
  setLockVersion,
  setPackageJsonVersion,
} from "./version-bump.mjs";
import { gitRepo } from "./gitRepo.test-support.mjs";

const SCRIPT = fileURLToPath(new URL("./version-bump.mjs", import.meta.url));

describe("bumpVersion", () => {
  it("bumps patch", () => {
    expect(bumpVersion("0.4.20", "patch")).toBe("0.4.21");
  });

  it("bumps minor and resets patch", () => {
    expect(bumpVersion("0.4.20", "minor")).toBe("0.5.0");
  });

  it("bumps major and resets minor and patch", () => {
    expect(bumpVersion("2.4.20", "major")).toBe("3.0.0");
  });

  it("rejects non-plain-semver versions", () => {
    expect(() => bumpVersion("0.4", "patch")).toThrow(/unsupported version/);
    expect(() => bumpVersion("0.4.20-beta", "patch")).toThrow(/unsupported version/);
  });

  it("rejects unknown bump kinds", () => {
    expect(() => bumpVersion("0.4.20", "breaking")).toThrow(/unknown bump kind/);
  });
});

describe("computeNext", () => {
  it("returns the current version for an empty kind list", () => {
    expect(computeNext("0.4.20", [])).toBe("0.4.20");
  });

  it("applies bumps in order, including reset boundaries", () => {
    expect(computeNext("0.4.20", ["patch", "minor", "patch", "major", "patch"])).toBe(
      "1.0.1",
    );
  });
});

describe("classifyMergeSubject", () => {
  it("treats a (minor) marker as a minor bump", () => {
    expect(classifyMergeSubject("Merge: settings screen (minor)")).toBe("minor");
  });

  it("treats a (major) marker as a major bump with precedence", () => {
    expect(classifyMergeSubject("Merge: new plugin API (major)")).toBe("major");
    expect(classifyMergeSubject("Merge: new plugin API (minor) (major)")).toBe("major");
  });

  it("defaults to patch, including legacy version-suffixed subjects", () => {
    expect(classifyMergeSubject("Merge: copy on Cmd+C (0.4.19)")).toBe("patch");
    expect(classifyMergeSubject("Merge branch 'feat/x'")).toBe("patch");
  });
});

describe("planBump", () => {
  it("applies the merges in merge order", () => {
    // Patch then minor lands on 0.2.0; the other way round it would be 0.2.1.
    expect(planBump("0.1.1", ["Merge: feature b", "Merge: stream done (minor)"], null)).toMatchObject({
      next: "0.2.0",
      kinds: ["patch", "minor"],
    });
  });

  it("applies a forced bump after the merges still pending", () => {
    expect(planBump("0.1.0", ["Merge: release boundary (minor)"], "patch").next).toBe("0.2.1");
    expect(planBump("0.1.0", [], "major").next).toBe("1.0.0");
  });

  it("has nothing to do when no merge landed and nothing is forced", () => {
    expect(planBump("0.1.0", [], null)).toBeNull();
  });

  it("releases a batch with a minor or major merge, and every forced bump — never a patch-only batch", () => {
    expect(planBump("0.1.0", ["Merge: a", "Merge: b"], null).release).toBe(false);
    expect(planBump("0.1.0", ["Merge: a", "Merge: b (minor)"], null).release).toBe(true);
    expect(planBump("0.1.0", ["Merge: a (major)"], null).release).toBe(true);
    expect(planBump("0.1.0", [], "patch").release).toBe(true);
  });
});

describe("readBumpArg", () => {
  it("reads the forced kind, or none without the flag", () => {
    expect(readBumpArg(["--bump", "minor"])).toBe("minor");
    expect(readBumpArg([])).toBeNull();
  });

  it("refuses anything but patch, minor or major", () => {
    expect(() => readBumpArg(["--bump", "breaking"])).toThrow(/--bump expects/);
    expect(() => readBumpArg(["--bump"])).toThrow(/got: \(nothing\)/);
  });
});

const CARGO_TOML_FIXTURE = `[package]
name = "keepdeck"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
`;

describe("manifest editing", () => {
  it("replaces only the [package] version in Cargo.toml", () => {
    const out = setCargoVersion(CARGO_TOML_FIXTURE, "0.1.1");
    expect(parseCargoVersion(out)).toBe("0.1.1");
    expect(out).toContain('tauri = { version = "2", features = [] }');
    expect(out).toContain('serde = { version = "1", features = ["derive"] }');
  });

  it("throws when Cargo.toml has no package version", () => {
    expect(() => setCargoVersion("[package]\nname = \"x\"\n", "1.0.0")).toThrow(
      /no package version/,
    );
  });

  it("replaces the root version in package.json and preserves formatting", () => {
    const json = `{\n  "name": "keepdeck",\n  "private": true,\n  "version": "0.1.0",\n  "dependencies": {\n    "react": "^19.1.0"\n  }\n}\n`;
    const out = setPackageJsonVersion(json, "0.1.1");
    expect(JSON.parse(out).version).toBe("0.1.1");
    expect(out).toContain('"react": "^19.1.0"');
    expect(out.endsWith("}\n")).toBe(true);
  });

  it("throws when package.json has no version field", () => {
    expect(() => setPackageJsonVersion('{"name":"x"}', "1.0.0")).toThrow(
      /no version field/,
    );
  });

  it("replaces only the named package's version in Cargo.lock", () => {
    const lock = `[[package]]
name = "infer"
version = "0.16.0"

[[package]]
name = "keepdeck"
version = "0.1.0"
dependencies = [
 "infer",
]

[[package]]
name = "keepdeck-git"
version = "0.1.0"
`;
    const out = setLockVersion(lock, "keepdeck", "0.1.1");
    expect(out).toContain('name = "keepdeck"\nversion = "0.1.1"');
    expect(out).toContain('name = "infer"\nversion = "0.16.0"');
    expect(out).toContain('name = "keepdeck-git"\nversion = "0.1.0"');
  });

  it("throws when the package is missing from Cargo.lock", () => {
    expect(() => setLockVersion("", "keepdeck", "1.0.0")).toThrow(/not found/);
  });
});

// What only a real repository shows: which commit is the anchor, which merges
// count from it, and the script's wiring — flags in, the three files and
// GITHUB_OUTPUT out. The rules over those merges are planBump's, above.
describe("the script, run in a real repository", () => {
  let repo;

  const versionFiles = (version) => ({
    "src-tauri/Cargo.toml": CARGO_TOML_FIXTURE.replace('version = "0.1.0"', `version = "${version}"`),
    "package.json": `{\n  "name": "keepdeck",\n  "version": "${version}"\n}\n`,
    "Cargo.lock": `[[package]]\nname = "infer"\nversion = "0.16.0"\n\n[[package]]\nname = "keepdeck"\nversion = "${version}"\n`,
  });
  const initial = { subject: "initial", files: versionFiles("0.1.0") };

  /** Run the script in `repo`: what it printed, and what it appended to
   * GITHUB_OUTPUT — a file under .git, out of the work tree it must leave
   * clean when there is nothing to bump. */
  const run = (...args) => {
    const output = join(repo, ".git", "github-output");
    writeFileSync(output, "");
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return { stdout, output: readFileSync(output, "utf8") };
  };

  const readVersions = () => ({
    cargo: parseCargoVersion(readFileSync(join(repo, "src-tauri/Cargo.toml"), "utf8")),
    pkg: JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version,
    lock: readFileSync(join(repo, "Cargo.lock"), "utf8").match(
      /name = "keepdeck"\nversion = "([^"]+)"/,
    )[1],
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("counts every merge from the root while the version never changed", () => {
    repo = gitRepo([initial, { subject: "Merge: feature a", merge: true }]);
    expect(run().output).toBe("version=0.1.1\nrelease=false\n");
    expect(readVersions()).toEqual({ cargo: "0.1.1", pkg: "0.1.1", lock: "0.1.1" });
  });

  it("counts from the newest commit that changed the version, in merge order", () => {
    repo = gitRepo([
      initial,
      { subject: "Merge: already released (minor)", merge: true },
      { subject: "Bump version to 0.2.0", files: versionFiles("0.2.0") },
      { subject: "Merge: feature b", merge: true },
      { subject: "Merge: stream done (minor)", merge: true },
    ]);
    run();
    // 0.2.0, then patch, then minor. Counting from the root would add the
    // released minor first (0.4.0); newest merge first would give 0.3.1.
    expect(readVersions().cargo).toBe("0.3.0");
  });

  it("takes a merge that set the version itself as the anchor — it never counts twice", () => {
    repo = gitRepo([
      initial,
      { subject: "Merge: legacy manual bump (0.2.0)", merge: true, files: versionFiles("0.2.0") },
    ]);
    const { stdout, output } = run();
    expect(stdout).toContain("nothing to bump");
    expect(output).toBe("");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe("");
  });

  it("applies --bump after the merges still pending, and releases it", () => {
    repo = gitRepo([initial, { subject: "Merge: release boundary (minor)", merge: true }]);
    expect(run("--bump", "patch").output).toBe("version=0.2.1\nrelease=true\n");
    expect(readVersions()).toEqual({ cargo: "0.2.1", pkg: "0.2.1", lock: "0.2.1" });
  });
});
