#!/usr/bin/env node
// Builds changelog.json — the accumulated per-version release notes the
// in-app updater shows when an update is available. Each published versioned
// release becomes one entry (newest-first); the rolling "latest" release,
// drafts and prereleases are skipped. The notes are the release bodies
// (composed by release-notes.mjs at publish time) with their per-entry chrome
// stripped — the leading "KeepDeck X." line and the trailing "Install:"
// footer — so only the change content remains. Zero dependencies; CI runs it
// in release.yml's publish job, and it works locally the same way.
//
//   node scripts/release-changelog.mjs --repo owner/name --out changelog.json \
//     [--version 1.2.3 --notes notes.md]
//
// Source is `gh api repos/:repo/releases` (REST), NOT `gh release list`:
// `gh release list --json` does not expose `body` (only gh release view does),
// and its default page is 30. The REST list returns `body` in-list and takes
// per_page, so one call covers the whole tail MAX_ENTRIES needs.
//
// The version being published is passed in as an authoritative HEAD entry
// (--version + --notes) so it is ALWAYS present — GitHub's releases-list
// endpoint is eventually consistent and omits a release for a few seconds
// after it is created, so listing it right after `gh release create` dropped
// the very version being published. The list still supplies every older entry;
// the head is deduped against it (head wins, its notes are the freshest).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
    else if (flag === "--version") args.version = argv[++i];
    else if (flag === "--notes") args.notes = argv[++i];
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const key of ["repo", "out"]) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  // The head entry needs both: a version to place it and a notes file to fill
  // it. One without the other is a mistake, not a partial head.
  if ((args.version == null) !== (args.notes == null)) {
    throw new Error("--version and --notes must be given together");
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
 *  versionFromTag, so plain Number arithmetic is exact for these magnitudes).
 *  Mirrors src/domain/changelog.ts's compareVersions, deliberately not shared:
 *  that one runs in the bundled app (BigInt + a non-numeric fallback), this
 *  one in a zero-build Node script on validated inputs — change both if the
 *  version ranking rules ever move (e.g. prerelease ordering). */
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

/** Pure builder over the raw GitHub REST release list (`gh api .../releases`):
 * drops drafts/prereleases/non-version tags (the rolling "latest"), strips each
 * body's per-entry chrome, sorts newest-first, and caps to the tail.
 *
 * `head` (or null) is the just-published release — `{ version, notes }`, notes
 * being its raw release body — injected authoritatively so the version being
 * published is present even when the list endpoint has not yet propagated it.
 * Its notes go through the same `cleanNotes` as list bodies, its date is
 * stamped `now` (the real published_at is seconds away and not yet listable),
 * and it is deduped against the list by version: the head wins, so a stale or
 * lagging list entry for the same version never doubles or overrides it. A head
 * whose version is not a valid tag is ignored (degrade to list-only), matching
 * this module's "fewer entries beats a crash" stance for a display-only file. */
export function buildChangelog(releases, head = null, now = () => new Date()) {
  const entries = [];
  const seen = new Set();
  const headVersion = head?.version ? versionFromTag(head.version) : null;
  if (headVersion) {
    entries.push({
      version: headVersion,
      notes: cleanNotes(head.notes ?? ""),
      date: now().toISOString(),
    });
    seen.add(headVersion);
  }
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = versionFromTag(release.tag_name ?? "");
    if (!version) continue; // the rolling "latest" tag, or a non-version tag
    if (seen.has(version)) continue; // already carried by the head (or a dup tag)
    seen.add(version);
    entries.push({
      version,
      notes: cleanNotes(release.body ?? ""),
      ...(release.published_at ? { date: release.published_at } : {}),
    });
  }
  entries.sort((a, b) => compareVersions(b.version, a.version));
  return { schema: SCHEMA, generatedAt: now().toISOString(), releases: entries.slice(0, MAX_ENTRIES) };
}

/** List published releases via the GitHub REST endpoint. `body` is not a field
 *  `gh release list --json` exposes, and its default page is 30 — REST returns
 *  both in one call. per_page=100 is GitHub's max for this endpoint and covers
 *  MAX_ENTRIES (50) with 2× headroom; `main` rejects a MAX_ENTRIES raised past
 *  100 rather than silently truncating, since this call does not paginate.
 *  `exec` is injected (defaulting to execFileSync) so the contract can be
 *  tested without mocking a node builtin — mirrors release-manifest.mjs's
 *  `buildManifest(args, read, now)` DI shape. */
export function listReleases(repo, exec = execFileSync) {
  const stdout = exec(
    "gh",
    ["api", `repos/${repo}/releases?per_page=100`],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

export function main(argv = process.argv.slice(2)) {
  if (MAX_ENTRIES > 100) {
    throw new Error(
      "MAX_ENTRIES exceeds gh api's per_page=100 cap; add pagination before raising it",
    );
  }
  const args = parseArgs(argv);
  const head = args.version
    ? { version: args.version, notes: readFileSync(args.notes, "utf8") }
    : null;
  const changelog = buildChangelog(listReleases(args.repo), head);
  writeFileSync(args.out, `${JSON.stringify(changelog, null, 2)}\n`);
  console.log(`Wrote ${args.out}: ${changelog.releases.length} release(s)`);
  return changelog;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
