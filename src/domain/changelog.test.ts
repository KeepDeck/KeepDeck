import { describe, expect, it } from "vitest";
import {
  compareVersions,
  sliceChangelog,
  type ChangelogEntry,
} from "./changelog";

describe("compareVersions", () => {
  it("is zero for equal versions", () => {
    expect(compareVersions("0.16.10", "0.16.10")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("orders by numeric segment, not string order", () => {
    // String order would put "0.16.10" before "0.16.2"; numeric does not.
    expect(compareVersions("0.16.2", "0.16.10")).toBeLessThan(0);
    expect(compareVersions("0.16.10", "0.16.2")).toBeGreaterThan(0);
  });

  it("compares major over minor over patch", () => {
    expect(compareVersions("0.15.9", "0.16.0")).toBeLessThan(0);
    expect(compareVersions("0.16.0", "0.16.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("treats a missing segment as zero", () => {
    expect(compareVersions("0.16", "0.16.0")).toBe(0);
    expect(compareVersions("0.16", "0.16.1")).toBeLessThan(0);
  });

  it("handles absurdly long numeric segments without precision loss", () => {
    expect(
      compareVersions("0.0.9007199254740993", "0.0.9007199254740992"),
    ).toBeGreaterThan(0);
  });

  it("falls back to string order for non-numeric segments", () => {
    // A pre-release tag the function can't fully rank still total-orders.
    expect(compareVersions("0.16.0-beta", "0.16.0-rc")).toBeLessThan(0);
  });
});

describe("sliceChangelog", () => {
  const entries: ChangelogEntry[] = [
    { version: "0.17.0", notes: "future" },
    { version: "0.16.0", notes: "sixteen" },
    { version: "0.15.0", notes: "fifteen" },
    { version: "0.14.0", notes: "current" },
    { version: "0.13.0", notes: "older" },
  ];

  it("includes releases strictly after current and up to the target", () => {
    const slice = sliceChangelog(entries, "0.14.0", "0.16.0");
    expect(slice.map((e) => e.version)).toEqual(["0.15.0", "0.16.0"]);
  });

  it("sorts oldest-first regardless of input order", () => {
    const shuffled: ChangelogEntry[] = [
      { version: "0.16.0", notes: "sixteen" },
      { version: "0.15.0", notes: "fifteen" },
    ];
    expect(sliceChangelog(shuffled, "0.14.0", "0.16.0").map((e) => e.version)).toEqual([
      "0.15.0",
      "0.16.0",
    ]);
  });

  it("spans an arbitrary gap — every intermediate release shows", () => {
    const slice = sliceChangelog(entries, "0.13.0", "0.17.0");
    expect(slice.map((e) => e.version)).toEqual([
      "0.14.0",
      "0.15.0",
      "0.16.0",
      "0.17.0",
    ]);
  });

  it("excludes the current version itself", () => {
    expect(sliceChangelog(entries, "0.14.0", "0.16.0")).not.toContainEqual(
      expect.objectContaining({ version: "0.14.0" }),
    );
  });

  it("is empty when current equals target (nothing to show)", () => {
    expect(sliceChangelog(entries, "0.16.0", "0.16.0")).toEqual([]);
  });

  it("is empty when no releases fall in range", () => {
    expect(sliceChangelog(entries, "0.17.0", "0.17.0")).toEqual([]);
  });

  it("collapses duplicate versions to their first occurrence", () => {
    const withDup: ChangelogEntry[] = [
      { version: "0.16.0", notes: "first" },
      { version: "0.16.0", notes: "second" },
      { version: "0.15.0", notes: "fifteen" },
    ];
    const slice = sliceChangelog(withDup, "0.14.0", "0.16.0");
    expect(slice).toHaveLength(2);
    expect(slice.find((e) => e.version === "0.16.0")?.notes).toBe("first");
  });

  it("does not rely on the channel's newest-first ordering", () => {
    const oldestFirst: ChangelogEntry[] = [
      { version: "0.15.0", notes: "fifteen" },
      { version: "0.16.0", notes: "sixteen" },
    ];
    expect(sliceChangelog(oldestFirst, "0.14.0", "0.16.0").map((e) => e.version)).toEqual([
      "0.15.0",
      "0.16.0",
    ]);
  });
});
