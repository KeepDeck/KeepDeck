import { describe, expect, it } from "vitest";
import { openAppsFrom, resolveOpenApp } from "./openIn";

describe("openAppsFrom", () => {
  it("reads the configured list in stored order", () => {
    expect(
      openAppsFrom({ openApps: ["Visual Studio Code", "IntelliJ IDEA"] }),
    ).toEqual(["Visual Studio Code", "IntelliJ IDEA"]);
  });

  it("trims entries and drops blanks and duplicates (hand-edited file)", () => {
    expect(
      openAppsFrom({ openApps: [" Zed ", "", "Zed", "  "] }),
    ).toEqual(["Zed"]);
  });

  it("yields an empty list for junk in the settings bag", () => {
    expect(openAppsFrom({})).toEqual([]);
    expect(openAppsFrom({ openApps: "Zed" })).toEqual([]);
    expect(openAppsFrom({ openApps: [1, { app: "Zed" }] })).toEqual([]);
  });
});

describe("resolveOpenApp", () => {
  const apps = ["Visual Studio Code", "IntelliJ IDEA"];

  it("keeps the workspace's pick while the list still has it", () => {
    expect(resolveOpenApp("IntelliJ IDEA", apps)).toBe("IntelliJ IDEA");
  });

  it("falls back to the list's first entry when the pick left the list", () => {
    // The pick itself survives in storage — re-adding the app restores it.
    expect(resolveOpenApp("Zed", apps)).toBe("Visual Studio Code");
    expect(resolveOpenApp(null, apps)).toBe("Visual Studio Code");
  });

  it("resolves to null when nothing is configured — the row hides", () => {
    expect(resolveOpenApp("Zed", [])).toBeNull();
  });
});
