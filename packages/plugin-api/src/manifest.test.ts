import { describe, expect, it } from "vitest";
import { readManifest } from "./manifest.ts";

/** A fully-populated valid manifest — the golden shape. */
const GOLDEN = {
  id: "dev.example-preview",
  name: "Preview",
  version: "1.0.0",
  minApiVersion: "0.0.1",
  description: "Preview localhost in a dock tab",
  capabilities: [
    { kind: "exec", commands: ["pnpm", "npm"] },
    { kind: "fs", scope: "workspace" },
    { kind: "net", domains: ["localhost"] },
    { kind: "ports" },
  ],
  contributes: {
    dockTabs: [{ id: "preview", label: "Preview" }],
    topBarActions: [{ id: "open", title: "Open preview" }],
    settings: true,
  },
};

describe("readManifest", () => {
  it("accepts the golden manifest verbatim", () => {
    const result = readManifest(GOLDEN);
    expect(result).toEqual({
      ok: true,
      manifest: {
        id: "dev.example-preview",
        name: "Preview",
        version: "1.0.0",
        minApiVersion: "0.0.1",
        description: "Preview localhost in a dock tab",
        capabilities: GOLDEN.capabilities,
        contributes: GOLDEN.contributes,
      },
    });
  });

  it("accepts a minimal manifest and defaults the optional parts", () => {
    const result = readManifest({
      id: "keepdeck.run",
      name: "Run",
      version: "0.1.0",
      minApiVersion: "0.0.1",
    });
    expect(result).toEqual({
      ok: true,
      manifest: {
        id: "keepdeck.run",
        name: "Run",
        version: "0.1.0",
        minApiVersion: "0.0.1",
        capabilities: [],
        contributes: {},
      },
    });
  });

  it("rejects a non-object outright", () => {
    expect(readManifest("nope")).toEqual({
      ok: false,
      errors: ["manifest must be a JSON object"],
    });
  });

  it("collects every error instead of stopping at the first", () => {
    const result = readManifest({
      id: "Bad_Id",
      name: "  ",
      version: "1.2",
      minApiVersion: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(4);
    expect(result.errors[0]).toContain("Bad_Id");
  });

  it("fails closed on an unknown capability kind", () => {
    const result = readManifest({
      ...GOLDEN,
      capabilities: [{ kind: "telepathy" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('unknown kind "telepathy"');
  });

  it("rejects malformed capability payloads per kind", () => {
    const cases: [unknown, string][] = [
      [{ kind: "exec", commands: [] }, "non-empty"],
      [{ kind: "exec" }, "non-empty"],
      [{ kind: "fs", scope: "disk" }, '"workspace" or "everywhere"'],
      [{ kind: "net", domains: ["*.evil.com"] }, "no wildcards"],
      [{ kind: "net", domains: [] }, "non-empty"],
    ];
    for (const [cap, expected] of cases) {
      const result = readManifest({ ...GOLDEN, capabilities: [cap] });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]).toContain(expected);
    }
  });

  it("rejects contribution entries without id or label", () => {
    const result = readManifest({
      ...GOLDEN,
      contributes: { dockTabs: [{ id: "", label: "X" }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("contributes.dockTabs[0]");
  });

  it("rejects id shapes outside the lowercase dotted grammar", () => {
    for (const bad of ["Run", "1run", "run..tab", "-run", "run_", "run."]) {
      const result = readManifest({ ...GOLDEN, id: bad });
      expect(result.ok, bad).toBe(false);
    }
    for (const good of ["run", "keepdeck.run", "a-b.c-d", "x0.y1"]) {
      const result = readManifest({ ...GOLDEN, id: good });
      expect(result.ok, good).toBe(true);
    }
  });
});
