import { describe, expect, it } from "vitest";
import { formatAge } from "../domain/usage";
import { reportedAgeCaption, usageLevelClass } from "./usageView";

describe("usageLevelClass", () => {
  it("colours a reading near a limit, and leaves a calm one alone", () => {
    expect(usageLevelClass("warn")).toBe("usage-level--warn");
    expect(usageLevelClass("critical")).toBe("usage-level--critical");
    expect(usageLevelClass(null)).toBeUndefined();
    expect(usageLevelClass(undefined)).toBeUndefined();
  });
});

describe("reportedAgeCaption", () => {
  it("says how long ago the account last reported", () => {
    const now = 1_800_000_000_000;
    const at = now - 5 * 60_000;
    expect(reportedAgeCaption(at, now)).toBe(`Updated ${formatAge(at, now)}`);
  });
});
