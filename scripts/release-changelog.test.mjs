import { describe, expect, it } from "vitest";
import { buildNotes } from "./release-notes.mjs";
import {
  MAX_ENTRIES,
  buildChangelog,
  cleanNotes,
  listReleases,
  parseArgs,
  versionFromTag,
} from "./release-changelog.mjs";

describe("parseArgs", () => {
  it("parses repo and out", () => {
    expect(parseArgs(["--repo", "KeepDeck/KeepDeck", "--out", "changelog.json"])).toEqual({
      repo: "KeepDeck/KeepDeck",
      out: "changelog.json",
    });
  });

  it.each([
    [["--out", "o"], /--repo is required/],
    [["--repo", "r"], /--out is required/],
    [["--oops"], /unknown argument: --oops/],
  ])("rejects bad arguments %j", (argv, error) => {
    expect(() => parseArgs(argv)).toThrow(error);
  });
});

describe("versionFromTag", () => {
  it("reads bare and v-prefixed semver tags", () => {
    expect(versionFromTag("0.16.10")).toBe("0.16.10");
    expect(versionFromTag("v1.2.0")).toBe("1.2.0");
  });

  it("rejects the rolling tag and non-version tags", () => {
    expect(versionFromTag("latest")).toBeNull();
    expect(versionFromTag("nightly-2026")).toBeNull();
  });
});

describe("cleanNotes", () => {
  it("strips the release-notes header line and install footer", () => {
    const body = "KeepDeck 1.2.0.\n\nChanges:\n- a\n- b\n\nInstall:\ncurl -fsSL https://x | sh\n";
    expect(cleanNotes(body)).toBe("Changes:\n- a\n- b");
  });

  it("leaves freeform notes without chrome untouched (trimmed)", () => {
    expect(cleanNotes("just notes  \n")).toBe("just notes");
  });

  it("is resilient to a missing body", () => {
    expect(cleanNotes(undefined)).toBe("");
  });

  it("round-trips release-notes.mjs buildNotes output (drift contract)", () => {
    // If release-notes.mjs changes its header/footer wording, cleanNotes would
    // silently leak chrome into every entry — this pins the two together.
    const body = buildNotes({
      version: "1.2.0",
      repo: "KeepDeck/KeepDeck",
      changes: ["Add foo", "Fix bar"],
    });
    expect(cleanNotes(body)).toBe("Changes:\n- Add foo\n- Fix bar");
  });
});

describe("buildChangelog", () => {
  const now = () => new Date("2026-07-22T10:00:00Z");

  // The raw GitHub REST release-list shape (`gh api repos/:repo/releases`).
  const rest = (fields) => ({
    draft: false,
    prerelease: false,
    ...fields,
  });

  it("keeps only published versioned releases, sorted newest-first", () => {
    const releases = [
      rest({ tag_name: "latest", body: "rolling", published_at: "2026-07-22T09:00:00Z" }),
      rest({ tag_name: "0.15.0", body: "KeepDeck 0.15.0.\n\nChanges:\n- fifteen", published_at: "2026-07-10T00:00:00Z" }),
      rest({ tag_name: "0.16.0", body: "KeepDeck 0.16.0.\n\nChanges:\n- sixteen", published_at: "2026-07-20T00:00:00Z" }),
    ];
    const out = buildChangelog(releases, now);
    expect(out.schema).toBe(1);
    expect(out.generatedAt).toBe("2026-07-22T10:00:00.000Z");
    expect(out.releases.map((r) => r.version)).toEqual(["0.16.0", "0.15.0"]);
    expect(out.releases[0]).toEqual({
      version: "0.16.0",
      notes: "Changes:\n- sixteen",
      date: "2026-07-20T00:00:00Z",
    });
  });

  it("drops drafts and prereleases (REST has no --exclude flag)", () => {
    const releases = [
      rest({ tag_name: "0.16.0", body: "sixteen" }),
      rest({ tag_name: "0.16.1-rc", body: "rc", prerelease: true }),
      rest({ tag_name: "0.17.0", body: "next", draft: true }),
    ];
    expect(buildChangelog(releases, now).releases.map((r) => r.version)).toEqual(["0.16.0"]);
  });

  it("omits date when the release was not published", () => {
    const out = buildChangelog([rest({ tag_name: "1.0.0", body: "x" })], now);
    expect(out.releases[0].date).toBeUndefined();
  });

  it("caps the tail at MAX_ENTRIES", () => {
    const releases = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) =>
      rest({ tag_name: `0.0.${i}`, body: "" }),
    );
    expect(buildChangelog(releases, now).releases).toHaveLength(MAX_ENTRIES);
    // Newest-first: the highest patch numbers survive.
    expect(buildChangelog(releases, now).releases[0].version).toBe(`0.0.${MAX_ENTRIES + 4}`);
  });
});

describe("listReleases", () => {
  it("calls gh api repos/:repo/releases with per_page=100 (the contract that was broken once)", () => {
    const calls = [];
    const exec = (...args) => {
      calls.push(args);
      return JSON.stringify([{ tag_name: "1.0.0", body: "x", published_at: "2026-07-20" }]);
    };
    const releases = listReleases("KeepDeck/KeepDeck", exec);
    expect(calls).toEqual([
      ["gh", ["api", "repos/KeepDeck/KeepDeck/releases?per_page=100"], { encoding: "utf8" }],
    ]);
    expect(releases).toEqual([{ tag_name: "1.0.0", body: "x", published_at: "2026-07-20" }]);
  });
});
