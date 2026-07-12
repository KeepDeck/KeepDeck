#!/usr/bin/env node
// Composes the rolling release's notes: the install one-liner plus a
// changelog — every merge subject landed since the previously RELEASED
// version (read from the live latest.json before it is overwritten). Merge
// subjects are behavior-descriptions by repo convention, so they are the
// changelog. Zero dependencies; CI runs it in release.yml's publish job from
// a full (fetch-depth: 0) checkout, and it works locally the same way.
//
//   node scripts/release-notes.mjs --version 1.3.0 --previous 1.2.0 \
//     --repo owner/name --out notes.md
//
// An empty/absent --previous (first release) or previous == version (a
// republish) skips the changelog section and keeps the existing story.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const args = { previous: "", rolling: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--version") args.version = argv[++i];
    else if (flag === "--previous") args.previous = argv[++i] ?? "";
    else if (flag === "--repo") args.repo = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--rolling") args.rolling = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const key of ["version", "repo", "out"]) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  return args;
}

/** A merge subject as a changelog line: the "Merge: " prefix and the release
 * markers are pipeline plumbing, not part of the change's story. */
export function changelogLine(subject) {
  return subject
    .replace(/^Merge:\s*/, "")
    .replace(/\s*\((?:minor|major)\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildNotes({ version, repo, changes, rolling = false }) {
  // The rolling entry is infrastructure, not a release: the installer and
  // the in-app updater read it by its fixed tag. Its notes say exactly that
  // and nothing else — per-version changelogs live on the archive releases,
  // so the two entries never read as duplicates.
  const lines = rolling
    ? [
        `Rolling release: always the newest build — currently ${version}.`,
        "The installer and the in-app updater read this entry; per-version",
        "changelogs live in the versioned releases.",
      ]
    : [`KeepDeck ${version}.`];
  if (!rolling && changes.length > 0) {
    lines.push("", "Changes:", ...changes.map((c) => `- ${c}`));
  }
  lines.push(
    "",
    "Install:",
    `curl -fsSL https://raw.githubusercontent.com/${repo}/main/install.sh | sh`,
  );
  return `${lines.join("\n")}\n`;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** The commit that put `previous` on main — the changelog window's floor. */
function findPreviousBump(previous) {
  const wanted = `Bump version to ${previous}`;
  const log = git("log", "--first-parent", "--format=%H %s", "HEAD");
  for (const entry of log.split("\n")) {
    const cut = entry.indexOf(" ");
    if (cut > 0 && entry.slice(cut + 1) === wanted) return entry.slice(0, cut);
  }
  return null;
}

export function collectChanges(previous, version) {
  // A republish of the same version, or a first release with no prior
  // manifest: there is no window to report.
  if (!previous || previous === version) return [];
  const anchor = findPreviousBump(previous);
  if (!anchor) return []; // history rewritten or shallow — degrade gracefully
  const subjects = git(
    "log",
    "--first-parent",
    "--merges",
    "--reverse",
    "--format=%s",
    `${anchor}..HEAD`,
  );
  return subjects.split("\n").filter(Boolean).map(changelogLine);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  // Rolling notes carry no changelog, so they need no git history either.
  const changes = args.rolling ? [] : collectChanges(args.previous, args.version);
  const notes = buildNotes({ ...args, changes });
  writeFileSync(args.out, notes);
  console.log(
    args.rolling
      ? `Wrote ${args.out}: rolling notes for ${args.version}`
      : `Wrote ${args.out}: ${changes.length} change(s) since ${args.previous || "(none)"}`,
  );
  return notes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
