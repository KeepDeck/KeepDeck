#!/usr/bin/env node
// Builds changelog.json — the accumulated per-version release notes the
// in-app updater shows when an update is available. Each published versioned
// release becomes one entry (newest-first); the rolling "latest" release and
// prereleases/drafts are skipped. The notes are the release bodies
// (composed by release-notes.mjs at publish time) with their per-entry chrome
// stripped — the leading "KeepDeck X." line and the trailing "Install:"
// footer — so only the change content remains. Zero dependencies; CI runs it
// in release.yml's publish job, and it works locally the same way.
//
//   node scripts/release-changelog.mjs --repo owner/name --out changelog.json
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SCHEMA = 1;
/** Releases beyond this tail length are dropped — nobody updates from a build
 *  old enough to need more, and the file stays small. */
export const MAX_ENTRIES = 50;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--repo") args.repo = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const key of ["repo", "out"]) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  return args;
}

/** The version a release's tag names. KeepDeck tags are bare ("0.16.10"); a
 *  leading `v` is tolerated so a future convention change doesn't silently
 *  drop every entry. Non-version tags (e.g. "latest") yield null. */
export function versionFromTag(tag) {
  const bare = tag.replace(/^v/, "");
  return /^\d+\.\d+\.\d+$/.test(bare) ? bare : null;
}

/** Strip the release-notes chrome (release-notes.mjs's header line and install
 *  footer) from a release body, leaving just the change content. Robust to a
 *  body that omits either piece (freeform notes, a future format). */
export function cleanNotes(body) {
  let notes = body ?? "";
  const footer = notes.indexOf("\nInstall:\n");
  if (footer >= 0) notes = notes.slice(0, footer);
  return notes.replace(/^KeepDeck \d+\.\d+\.\d+\.\s*/, "").replace(/\s+$/, "");
}

/** Numeric compare of two dotted versions (the tags are validated semver by
 *  versionFromTag, so plain Number arithmetic is exact for these magnitudes). */
function compareVersions(a, b) {
  const aa = a.split(".");
  const bb = b.split(".");
  const last = Math.max(aa.length, bb.length);
  for (let i = 0; i < last; i++) {
    const diff = Number(aa[i] ?? "0") - Number(bb[i] ?? "0");
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Pure builder: sort published versioned releases newest-first, strip chrome,
 *  and cap to the tail. `releases` is the raw `gh release list --json` shape. */
export function buildChangelog(releases, now = () => new Date()) {
  const entries = [];
  for (const release of releases) {
    const version = versionFromTag(release.tagName ?? "");
    if (!version) continue; // the rolling "latest" tag, or a non-version tag
    entries.push({
      version,
      notes: cleanNotes(release.body ?? ""),
      ...(release.publishedAt ? { date: release.publishedAt } : {}),
    });
  }
  entries.sort((a, b) => compareVersions(b.version, a.version));
  return { schema: SCHEMA, generatedAt: now().toISOString(), releases: entries.slice(0, MAX_ENTRIES) };
}

function listReleases(repo) {
  const stdout = execFileSync(
    "gh",
    [
      "release",
      "list",
      "--repo",
      repo,
      "--exclude-drafts",
      "--exclude-pre-releases",
      "--json",
      "tagName,publishedAt,body",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const changelog = buildChangelog(listReleases(args.repo));
  writeFileSync(args.out, `${JSON.stringify(changelog, null, 2)}\n`);
  console.log(`Wrote ${args.out}: ${changelog.releases.length} release(s)`);
  return changelog;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
