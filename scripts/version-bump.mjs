#!/usr/bin/env node
// Bumps the app version on main after merges. Zero dependencies; CI runs it
// via .github/workflows/version-bump.yml, and it can be run locally the same
// way (it only edits files — committing is the caller's job).
//
// Auto mode (default): find the newest first-parent commit where the package
// version changed (the "anchor" — the commit that introduced the current
// version), then classify every merge into main since it: "(major)" bumps
// major, "(minor)" bumps minor, and every other merge bumps patch. Bumps apply
// in merge order, so one run can cover several merges (e.g. a failed CI push
// is healed by the next run recounting from the same anchor). A merge that
// already changed the version itself becomes the anchor, so manually bumped
// merges are respected and never double-counted.
//
// Dispatch mode (--bump patch|minor|major): append exactly one forced bump
// after any merge bumps not yet reflected in the version. Every forced bump is
// a release, including a forced patch.
//
// Writes src-tauri/Cargo.toml (the declared source of truth), package.json
// and the keepdeck entry in Cargo.lock. Prints the new version and, when
// GITHUB_OUTPUT is set, appends version=<new> and release=<bool> for the
// workflow.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CARGO_TOML = "src-tauri/Cargo.toml";
const PACKAGE_JSON = "package.json";
const CARGO_LOCK = "Cargo.lock";
const LOCK_PACKAGE = "keepdeck";
const MAJOR_MARKER = "(major)";
const MINOR_MARKER = "(minor)";

export function bumpVersion(version, kind) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`unsupported version format: ${version}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump kind: ${kind}`);
}

export function computeNext(current, kinds) {
  return kinds.reduce(bumpVersion, current);
}

export function classifyMergeSubject(subject) {
  if (subject.includes(MAJOR_MARKER)) return "major";
  return subject.includes(MINOR_MARKER) ? "minor" : "patch";
}

export function parseCargoVersion(toml) {
  // Only the [package] version sits at line start; dependency versions live
  // mid-line inside tables (`tauri = { version = "2", … }`) and never match.
  const m = toml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error(`no package version found in ${CARGO_TOML}`);
  return m[1];
}

export function setCargoVersion(toml, version) {
  parseCargoVersion(toml);
  return toml.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
}

export function setPackageJsonVersion(json, version) {
  const re = /("version"\s*:\s*")[^"]+(")/;
  if (!re.test(json)) throw new Error(`no version field found in ${PACKAGE_JSON}`);
  return json.replace(re, `$1${version}$2`);
}

export function setLockVersion(lock, name, version) {
  const re = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")[^"]+(")`,
  );
  if (!re.test(lock)) throw new Error(`package ${name} not found in ${CARGO_LOCK}`);
  return lock.replace(re, `$1${version}$2`);
}

function git(...args) {
  // stderr stays piped (not inherited) so expected probe failures — e.g.
  // resolving `<root>^` in findAnchor — don't pollute CI logs.
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function versionAt(ref) {
  return parseCargoVersion(git("show", `${ref}:${CARGO_TOML}`));
}

// Newest first-parent commit where the package version changed relative to
// its first parent — i.e. the commit that put the current version on main.
function findAnchor() {
  const touched = git("log", "--first-parent", "--format=%H", "--", CARGO_TOML)
    .split("\n")
    .filter(Boolean);
  for (const sha of touched) {
    let parentVersion;
    try {
      parentVersion = versionAt(`${sha}^`);
    } catch {
      return sha; // root commit, or the manifest didn't exist before this commit
    }
    if (versionAt(sha) !== parentVersion) return sha;
  }
  return touched.at(-1) ?? null;
}

function readBumpArg(argv) {
  const i = argv.indexOf("--bump");
  if (i === -1) return null;
  const kind = argv[i + 1];
  if (kind !== "patch" && kind !== "minor" && kind !== "major") {
    throw new Error(
      `--bump expects "patch", "minor" or "major", got: ${kind ?? "(nothing)"}`,
    );
  }
  return kind;
}

export function main(argv = process.argv.slice(2)) {
  const forced = readBumpArg(argv);
  const current = parseCargoVersion(readFileSync(CARGO_TOML, "utf8"));

  const anchor = findAnchor();
  const subjects =
    anchor === null
      ? []
      : git(
          "log",
          "--first-parent",
          "--merges",
          "--reverse",
          "--format=%s",
          `${anchor}..HEAD`,
        )
          .split("\n")
          .filter(Boolean);
  const kinds = subjects.map(classifyMergeSubject);
  if (forced) kinds.push(forced);
  if (kinds.length === 0) {
    console.log("No merges since the last version change; nothing to bump.");
    return null;
  }

  const next = computeNext(current, kinds);
  writeFileSync(CARGO_TOML, setCargoVersion(readFileSync(CARGO_TOML, "utf8"), next));
  writeFileSync(
    PACKAGE_JSON,
    setPackageJsonVersion(readFileSync(PACKAGE_JSON, "utf8"), next),
  );
  writeFileSync(
    CARGO_LOCK,
    setLockVersion(readFileSync(CARGO_LOCK, "utf8"), LOCK_PACKAGE, next),
  );
  console.log(`Bump version to ${next} (${current} + ${kinds.join(", ")})`);
  if (process.env.GITHUB_OUTPUT) {
    // Automatic patch batches only update the version. Major/minor batches and
    // every forced bump build a release before the version commit is pushed.
    const release = forced !== null || kinds.some((kind) => kind !== "patch");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${next}\nrelease=${release}\n`,
    );
  }
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
