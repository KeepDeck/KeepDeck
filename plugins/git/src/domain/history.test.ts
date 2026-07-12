import { describe, expect, it } from "vitest";
import {
  commitRange,
  historyRow,
  relativeTime,
  shortSha,
  sinceForkRange,
} from "./history";

describe("ranges", () => {
  it("a commit's range runs parent-to-itself; since-fork stays open-ended", () => {
    expect(commitRange("abc123")).toEqual({ from: "abc123^", to: "abc123" });
    // No `to`: the diff reaches the WORKING TREE, so uncommitted work counts.
    expect(sinceForkRange("fork456")).toEqual({ from: "fork456" });
  });
});

describe("shortSha", () => {
  it("abbreviates to git's seven", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 6, 12, 12, 0, 0); // 2026-07-12T12:00Z
  const at = (secondsAgo: number) => Math.floor(now / 1000) - secondsAgo;

  it("steps through now/minutes/hours/days and lands on a date", () => {
    expect(relativeTime(at(5), now)).toBe("now");
    expect(relativeTime(at(90), now)).toBe("1m");
    expect(relativeTime(at(59 * 60), now)).toBe("59m");
    expect(relativeTime(at(3 * 3600), now)).toBe("3h");
    expect(relativeTime(at(2 * 86400), now)).toBe("2d");
    expect(relativeTime(at(45 * 86400), now)).toMatch(/May \d+/);
  });

  it("a clock skewed into the future reads as now, not negative", () => {
    expect(relativeTime(at(-120), now)).toBe("now");
  });
});

describe("historyRow", () => {
  it("maps a changed file to a history-kind peek row", () => {
    expect(
      historyRow({ path: "src/new.ts", origPath: "src/old.ts", code: "R" }),
    ).toEqual({
      path: "src/new.ts",
      origPath: "src/old.ts",
      code: "R",
      kind: "history",
    });
  });
});
