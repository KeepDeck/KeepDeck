import { describe, expect, it } from "vitest";
import { sameSkillScope, skillScopeKey, skillScopeOf } from "./skills";

describe("the bundled scope variant", () => {
  it("skillScopeOf maps a bundled row to the third kind", () => {
    expect(skillScopeOf({ scope: "bundled", wsId: null })).toEqual({
      kind: "bundled",
    });
  });

  it("sameSkillScope: bundled equals bundled, nothing else", () => {
    expect(sameSkillScope({ kind: "bundled" }, { kind: "bundled" })).toBe(true);
    expect(sameSkillScope({ kind: "bundled" }, { kind: "global" })).toBe(false);
    expect(sameSkillScope({ kind: "global" }, { kind: "bundled" })).toBe(false);
    expect(
      sameSkillScope({ kind: "bundled" }, { kind: "workspace", wsId: "ws-1" }),
    ).toBe(false);
  });

  it("skillScopeKey gives the bundled kind its own stable key", () => {
    expect(skillScopeKey({ kind: "bundled" })).toBe("bundled");
    expect(skillScopeKey({ kind: "global" })).toBe("global");
    expect(skillScopeKey({ kind: "workspace", wsId: "ws-1" })).toBe("ws:ws-1");
  });

  it("the old scopes still round-trip unchanged", () => {
    expect(skillScopeOf({ scope: "global", wsId: null })).toEqual({
      kind: "global",
    });
    expect(skillScopeOf({ scope: "workspace", wsId: "ws-2" })).toEqual({
      kind: "workspace",
      wsId: "ws-2",
    });
  });
});
