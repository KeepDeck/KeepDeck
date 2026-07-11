import { describe, expect, it } from "vitest";
import { readManifest } from "./manifest.ts";

/** A fully-populated valid manifest — the golden shape. */
const GOLDEN = {
  id: "dev.example-preview",
  name: "Preview",
  version: "1.0.0",
  minApiVersion: 1,
  description: "Preview localhost in a dock tab",
  capabilities: [
    { kind: "exec", commands: ["pnpm", "npm"] },
    { kind: "fs", scope: "workspace" },
    { kind: "git", scope: "workspace" },
    { kind: "net", domains: ["localhost"] },
    { kind: "ports" },
    { kind: "open" },
  ],
  contributes: {
    dockTabs: [{ id: "preview", label: "Preview" }],
    topBarActions: [{ id: "open", label: "Open preview" }],
    fileOpeners: [{ id: "peek", label: "Preview peek" }],
    overlays: [{ id: "viewer", label: "Preview viewer" }],
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
        minApiVersion: 1,
        category: "deck",
        description: "Preview localhost in a dock tab",
        capabilities: GOLDEN.capabilities,
        contributes: GOLDEN.contributes,
      },
    });
  });

  describe("category", () => {
    it("accepts explicit values (the golden default is pinned above)", () => {
      const cli = readManifest({
        ...GOLDEN,
        category: "cli",
        contributes: { agents: [{ id: "claude", label: "Claude Code" }] },
      });
      expect(cli.ok && cli.manifest.category).toBe("cli");
      const deck = readManifest({ ...GOLDEN, category: "deck" });
      expect(deck.ok && deck.manifest.category).toBe("deck");
    });

    it("rejects unknown categories", () => {
      const result = readManifest({ ...GOLDEN, category: "theme" });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.errors.some((e) => e.startsWith("category:"))).toBe(true);
    });

    it("bounds the contribution surface by category", () => {
      // A cli plugin may not contribute deck chrome — all four kinds.
      const cli = readManifest({
        ...GOLDEN,
        category: "cli",
        contributes: {
          ...GOLDEN.contributes,
          paneActions: [{ id: "pa", label: "PA" }],
        },
      });
      expect(cli.ok).toBe(false);
      if (!cli.ok) {
        for (const kind of [
          "dockTabs",
          "topBarActions",
          "paneActions",
          "fileOpeners",
          "overlays",
        ]) {
          expect(cli.errors).toContain(
            `contributes.${kind}: a "cli" plugin contributes agents, not deck chrome`,
          );
        }
      }
      // …and a deck plugin may not sneak in an agent.
      const deck = readManifest({
        ...GOLDEN,
        contributes: {
          ...GOLDEN.contributes,
          agents: [{ id: "claude", label: "Claude Code" }],
        },
      });
      expect(deck.ok).toBe(false);
      if (!deck.ok)
        expect(deck.errors).toContain(
          'contributes.agents: requires category "cli"',
        );
    });
  });

  it("accepts a minimal manifest and defaults the optional parts", () => {
    const result = readManifest({
      id: "keepdeck.run",
      name: "Run",
      version: "0.1.0",
      minApiVersion: 1,
    });
    expect(result).toEqual({
      ok: true,
      manifest: {
        id: "keepdeck.run",
        name: "Run",
        version: "0.1.0",
        minApiVersion: 1,
        category: "deck",
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
      [{ kind: "git", scope: "disk" }, '"workspace" or "everywhere"'],
      [{ kind: "git" }, '"workspace" or "everywhere"'],
      [{ kind: "net", domains: ["*.evil.com"] }, "bare hostnames"],
      [{ kind: "net", domains: [] }, "non-empty"],
      // A domain must be a bare hostname — anything carrying a CSP separator
      // or CR/LF would inject/break the realm's connect-src header.
      [{ kind: "net", domains: ["a.com; frame-src *"] }, "bare hostnames"],
      [{ kind: "net", domains: ["evil\r\nX: 1"] }, "bare hostnames"],
      [{ kind: "net", domains: ["https://a.com"] }, "bare hostnames"],
      [{ kind: "net", domains: ["a.com/path"] }, "bare hostnames"],
    ];
    for (const [cap, expected] of cases) {
      const result = readManifest({ ...GOLDEN, capabilities: [cap] });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]).toContain(expected);
    }
  });

  it("rejects a contribution id that isn't a path-safe token", () => {
    // A dock-tab id becomes `<id>.html` in the iframe URL — slashes, dots,
    // and whitespace could address a different path under the plugin origin.
    for (const bad of ["../foo", "a/b", "a.b", "a b", "tab!"]) {
      const result = readManifest({
        ...GOLDEN,
        contributes: { dockTabs: [{ id: bad, label: "X" }] },
      });
      expect(result.ok, bad).toBe(false);
    }
    const ok = readManifest({
      ...GOLDEN,
      contributes: { dockTabs: [{ id: "my-tab_2", label: "X" }] },
    });
    expect(ok.ok).toBe(true);
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
