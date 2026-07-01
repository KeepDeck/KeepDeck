import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bumpVersion,
  classifyMergeSubject,
  computeNext,
  parseCargoVersion,
  setCargoVersion,
  setLockVersion,
  setPackageJsonVersion,
} from "./version-bump.mjs";

const SCRIPT = fileURLToPath(new URL("./version-bump.mjs", import.meta.url));

describe("bumpVersion", () => {
  it("bumps patch", () => {
    expect(bumpVersion("0.4.20", "patch")).toBe("0.4.21");
  });

  it("bumps minor and resets patch", () => {
    expect(bumpVersion("0.4.20", "minor")).toBe("0.5.0");
  });

  it("rejects non-plain-semver versions", () => {
    expect(() => bumpVersion("0.4", "patch")).toThrow(/unsupported version/);
    expect(() => bumpVersion("0.4.20-beta", "patch")).toThrow(/unsupported version/);
  });

  it("rejects unknown bump kinds", () => {
    expect(() => bumpVersion("0.4.20", "major")).toThrow(/unknown bump kind/);
  });
});

describe("computeNext", () => {
  it("returns the current version for an empty kind list", () => {
    expect(computeNext("0.4.20", [])).toBe("0.4.20");
  });

  it("applies bumps in order (minor resets patch mid-chain)", () => {
    expect(computeNext("0.4.20", ["patch", "minor", "patch"])).toBe("0.5.1");
  });
});

describe("classifyMergeSubject", () => {
  it("treats a (minor) marker as a minor bump", () => {
    expect(classifyMergeSubject("Merge: settings screen (minor)")).toBe("minor");
  });

  it("defaults to patch, including legacy version-suffixed subjects", () => {
    expect(classifyMergeSubject("Merge: copy on Cmd+C (0.4.19)")).toBe("patch");
    expect(classifyMergeSubject("Merge branch 'feat/x'")).toBe("patch");
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

describe("end-to-end against a real git repo", () => {
  let repo;

  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

  const runScript = (...args) =>
    execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "" },
    });

  const readVersions = () => ({
    cargo: parseCargoVersion(readFileSync(join(repo, "src-tauri/Cargo.toml"), "utf8")),
    pkg: JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version,
    lock: readFileSync(join(repo, "Cargo.lock"), "utf8").match(
      /name = "keepdeck"\nversion = "([^"]+)"/,
    )[1],
  });

  const writeVersionFiles = (version) => {
    writeFileSync(
      join(repo, "src-tauri/Cargo.toml"),
      CARGO_TOML_FIXTURE.replace('version = "0.1.0"', `version = "${version}"`),
    );
    writeFileSync(
      join(repo, "package.json"),
      `{\n  "name": "keepdeck",\n  "version": "${version}"\n}\n`,
    );
    writeFileSync(
      join(repo, "Cargo.lock"),
      `[[package]]\nname = "infer"\nversion = "0.16.0"\n\n[[package]]\nname = "keepdeck"\nversion = "${version}"\n`,
    );
  };

  const mergeFeature = (branch, subject, mutate) => {
    git("checkout", "-q", "-b", branch);
    if (mutate) {
      mutate();
    } else {
      writeFileSync(join(repo, `${branch.replaceAll("/", "-")}.txt`), branch);
    }
    git("add", "-A");
    git("commit", "-q", "-m", `work on ${branch}`);
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", subject, branch);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "version-bump-"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    mkdirSync(join(repo, "src-tauri"));
    writeVersionFiles("0.1.0");
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("bumps patch once for a single merge (bootstrap: anchor is the root commit)", () => {
    mergeFeature("feat/a", "Merge: feature a");
    runScript();
    expect(readVersions()).toEqual({ cargo: "0.1.1", pkg: "0.1.1", lock: "0.1.1" });
  });

  it("covers several merges in one run, honoring (minor) in order", () => {
    mergeFeature("feat/a", "Merge: feature a");
    runScript();
    git("commit", "-qam", "Bump version to 0.1.1");

    mergeFeature("feat/b", "Merge: feature b");
    mergeFeature("feat/c", "Merge: stream done (minor)");
    runScript();
    // 0.1.1 → patch → 0.1.2 → minor → 0.2.0
    expect(readVersions().cargo).toBe("0.2.0");
  });

  it("is a no-op when no merges landed since the last version change", () => {
    mergeFeature("feat/a", "Merge: feature a");
    runScript();
    git("commit", "-qam", "Bump version to 0.1.1");

    const out = runScript();
    expect(out).toContain("nothing to bump");
    expect(readVersions().cargo).toBe("0.1.1");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("respects a merge that already bumped the version manually", () => {
    mergeFeature("feat/legacy", "Merge: legacy manual bump (0.2.0)", () =>
      writeVersionFiles("0.2.0"),
    );
    const out = runScript();
    expect(out).toContain("nothing to bump");
    expect(readVersions().cargo).toBe("0.2.0");
  });

  it("applies exactly one forced bump in dispatch mode, ignoring history", () => {
    runScript("--bump", "minor");
    expect(readVersions()).toEqual({ cargo: "0.2.0", pkg: "0.2.0", lock: "0.2.0" });
  });

  it("rejects an invalid --bump argument", () => {
    expect(() => runScript("--bump", "major")).toThrow();
  });
});
