import { describe, expect, it } from "vitest";
import type { ArgSpec } from "./args";
import { validateArgs } from "./args";

const SPECS: ArgSpec[] = [
  { name: "workspace", type: "string", required: true, description: "target" },
  { name: "task", type: "string", description: "initial prompt" },
  { name: "submit", type: "boolean", description: "press enter" },
  { name: "count", type: "number", description: "how many" },
];

describe("validateArgs", () => {
  it("accepts a valid full and minimal call", () => {
    expect(
      validateArgs(SPECS, {
        workspace: "web",
        task: "fix header",
        submit: true,
        count: 2,
      }),
    ).toEqual([]);
    expect(validateArgs(SPECS, { workspace: "web" })).toEqual([]);
  });

  it("reports a missing required argument", () => {
    expect(validateArgs(SPECS, {})).toEqual([
      'missing required argument "workspace"',
    ]);
  });

  it("rejects unknown keys instead of ignoring them", () => {
    expect(validateArgs(SPECS, { workspace: "web", tsak: "typo" })).toEqual([
      'unknown argument "tsak"',
    ]);
  });

  it("checks primitive types", () => {
    expect(validateArgs(SPECS, { workspace: 5 })).toEqual([
      'argument "workspace" must be a string',
    ]);
    expect(validateArgs(SPECS, { workspace: "web", submit: "yes" })).toEqual([
      'argument "submit" must be a boolean',
    ]);
  });

  it("collects several problems in one pass", () => {
    const errors = validateArgs(SPECS, { bogus: 1, submit: "yes" });
    expect(errors).toContain('unknown argument "bogus"');
    expect(errors).toContain('missing required argument "workspace"');
    expect(errors).toContain('argument "submit" must be a boolean');
  });
});
