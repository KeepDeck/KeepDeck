import { describe, expect, it } from "vitest";
import {
  allNetAllowances,
  credentialEntry,
  declaresPermissions,
  isResolvedPermissions,
  type ResolvedPermissions,
} from "./permissions";

const resolved: ResolvedPermissions = {
  env: { TOOL_HOME: null },
  net: [
    { allow: ["127.0.0.1"], credentials: [] },
    { allow: ["api.tool.example"], credentials: [{ id: "tool", dir: "/h/creds", tokenFields: ["t"] }] },
  ],
};

describe("resolved permissions", () => {
  it("asks the native side only for manifests that declare env or net", () => {
    expect(declaresPermissions([{ kind: "fs", scope: "workspace" }])).toBe(false);
    expect(declaresPermissions([{ kind: "env", names: ["A"] }])).toBe(true);
    expect(declaresPermissions([{ kind: "net", domains: ["a.example"] }])).toBe(true);
  });

  it("gives an unsigned request every entry's reach, a signed one only its own entry's", () => {
    expect(allNetAllowances(resolved)).toEqual(["127.0.0.1", "api.tool.example"]);
    expect(credentialEntry(resolved, "tool")).toEqual({
      allow: ["api.tool.example"],
      credential: { id: "tool", dir: "/h/creds", tokenFields: ["t"] },
    });
    expect(credentialEntry(resolved, "other")).toBeUndefined();
  });

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
