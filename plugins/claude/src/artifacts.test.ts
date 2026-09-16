import { describe, expect, it } from "vitest";
import { mergeSectionValues } from "@keepdeck/plugin-api";
import {
  ARTIFACTS_FIELD,
  DISABLE_ARTIFACTS_VAR,
  artifactsEnv,
} from "./artifacts";

const section = { label: "Claude Code", fields: [ARTIFACTS_FIELD] };

/** What the host hands the plugin for a given settings-file bag — resolved
 * through the CONTRACT's own merge, so the key the field declares and the
 * key the reader looks up are proven to be the same one. */
const resolved = (stored: Record<string, unknown>) =>
  mergeSectionValues(section, stored);

describe("claude artifacts switch", () => {
  it("is ON by default and says which artifacts these are", () => {
    expect(ARTIFACTS_FIELD.default).toBe(true);
    // Names the destination: "artifacts" alone reads as the deck's own.
    expect(ARTIFACTS_FIELD.label).toContain("claude.ai");
    expect(ARTIFACTS_FIELD.description).toContain("Fleet artifacts");
    expect(ARTIFACTS_FIELD.description).toMatch(/started after/);
  });

  it("switched off, asks for the disable variable with a value claude honours", () => {
    expect(artifactsEnv(resolved({ artifacts: false }))).toEqual([
      [DISABLE_ARTIFACTS_VAR, "1"],
    ]);
  });

  it("on — by default or explicitly — emits nothing: no value says on louder than absence", () => {
    // Not "sets it to 0": claude reads only 1/true/yes/on as a disable, so
    // "0" would be harmless but a lie about what the deck can do — it cannot
    // override the user's own settings, and must not look like it does.
    expect(artifactsEnv(resolved({}))).toEqual([]);
    expect(artifactsEnv(resolved({ artifacts: true }))).toEqual([]);
    // A hand-edited file with the wrong shape resolves to the default, not
    // to off.
    expect(artifactsEnv(resolved({ artifacts: "false" }))).toEqual([]);
  });
});
