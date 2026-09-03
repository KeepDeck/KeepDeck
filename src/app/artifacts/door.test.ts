import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../domain/settings";
import { artifactsDoorOpen } from "./door";

const settings = (artifacts: boolean): Settings => ({
  ...DEFAULT_SETTINGS,
  artifacts,
});

describe("artifactsDoorOpen", () => {
  it("offers the door only for a setting that says so", () => {
    expect(artifactsDoorOpen(settings(true))).toBe(true);
    expect(artifactsDoorOpen(settings(false))).toBe(false);
  });

  it("offers nothing before the settings have loaded", () => {
    // `null` is "not known yet", not "off" — but a guess in either
    // direction is wrong, and the guess that opens an experiment the user
    // disabled is the one that does damage.
    expect(artifactsDoorOpen(null)).toBe(false);
  });
});
