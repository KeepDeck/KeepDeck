import { describe, expect, it } from "vitest";
import {
  MAX_ENTRIES,
  buildChangelog,
  cleanNotes,
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
});

describe("buildChangelog", () => {
  const now = () => new Date("2026-07-22T10:00:00Z");

  it("keeps only versioned releases, sorted newest-first", () => {
    const releases = [
      { tagName: "latest", body: "rolling", publishedAt: "2026-07-22T09:00:00Z" },
      { tagName: "0.15.0", body: "KeepDeck 0.15.0.\n\nChanges:\n- fifteen", publishedAt: "2026-07-10T00:00:00Z" },
      { tagName: "0.16.0", body: "KeepDeck 0.16.0.\n\nChanges:\n- sixteen", publishedAt: "2026-07-20T00:00:00Z" },
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

  it("omits date when the release was not published", () => {
    const out = buildChangelog([{ tagName: "1.0.0", body: "x" }], now);
    expect(out.releases[0].date).toBeUndefined();
  });

  it("caps the tail at MAX_ENTRIES", () => {
    const releases = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({
      tagName: `0.0.${i}`,
      body: "",
    }));
    expect(buildChangelog(releases, now).releases).toHaveLength(MAX_ENTRIES);
    // Newest-first: the highest patch numbers survive.
    expect(buildChangelog(releases, now).releases[0].version).toBe(`0.0.${MAX_ENTRIES + 4}`);
  });
});
