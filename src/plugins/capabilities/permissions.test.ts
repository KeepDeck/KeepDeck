import { describe, expect, it } from "vitest";
import { isResolvedPermissions, type ResolvedPermissions } from "./permissions";

const resolved: ResolvedPermissions = {
  env: { TOOL_HOME: null },
  net: [
    { allow: ["127.0.0.1"], credentials: [] },
    { allow: ["api.tool.example"], credentials: [{ id: "tool", dir: "/h/creds", tokenFields: ["t"] }] },
  ],
};

describe("resolved permissions", () => {
  it("accepts only the native answer's exact shape", () => {
    expect(isResolvedPermissions(resolved)).toBe(true);
    for (const bad of [
      null,
      { env: [], net: [] },
      { env: { A: 1 }, net: [] },
      { env: {}, net: [{ allow: "a", credentials: [] }] },
      { env: {}, net: [{ allow: [], credentials: [{ id: "t", dir: 1, tokenFields: [] }] }] },
    ]) {
      expect(isResolvedPermissions(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
