import { describe, expect, it } from "vitest";
import { declaredAgentBins, readManifest } from "./manifest.ts";

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
    {
      kind: "legacyDownloads",
      migrations: [{ source: "models", target: "models", stripSingleRoots: true }],
    },
    { kind: "ports" },
    { kind: "open" },
    { kind: "commands", execute: ["agent.*", "workspace.switch"] },
  ],
  contributes: {
    dockTabs: [{ id: "preview", label: "Preview" }],
    topBarActions: [{ id: "open", label: "Open preview" }],
    fileOpeners: [{ id: "peek", label: "Preview peek" }],
    overlays: [{ id: "viewer", label: "Preview viewer" }],
    commands: [{ id: "refresh", label: "Refresh the preview" }],
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

  it("carries experimental only when explicitly true", () => {
    const on = readManifest({ ...GOLDEN, experimental: true });
    expect(on.ok && on.manifest.experimental).toBe(true);
    // Absent or any non-true value = stable (the key is omitted).
    for (const value of [undefined, false, "yes", 1]) {
      const r = readManifest({ ...GOLDEN, experimental: value });
      expect(r.ok && "experimental" in r.manifest).toBe(false);
    }
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

  it("rejects a name that could forge trust: overlong, control/bidi chars, or the app's own", () => {
    const base = {
      id: "x.y",
      version: "1.0.0",
      minApiVersion: 1,
      category: "deck",
      capabilities: [],
      contributes: {},
    };
    const errorFor = (name: string) => {
      const result = readManifest({ ...base, name });
      return result.ok ? null : result.errors.join("; ");
    };
    expect(errorFor("n".repeat(41))).toContain("longer than 40");
    expect(errorFor("Git\nTools")).toContain("control or bidi");
    expect(errorFor("Git‮Tools")).toContain("control or bidi");
    expect(errorFor("KeepDeck")).toContain("impersonates the app");
    expect(errorFor(" keepdeck ")).toContain("impersonates the app");
    // The boundary cases stay legal.
    expect(errorFor("n".repeat(40))).toBeNull();
    expect(errorFor("KeepDeck Git Tools")).toBeNull();
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

  it("accepts an fsWrite capability with declared prefixes", () => {
    const result = readManifest({
      ...GOLDEN,
      capabilities: [{ kind: "fsWrite", paths: ["~/.claude/projects"] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.capabilities).toEqual([
      { kind: "fsWrite", paths: ["~/.claude/projects"] },
    ]);
  });

  it("accepts the paramless clipboard capabilities", () => {
    const result = readManifest({
      ...GOLDEN,
      capabilities: [{ kind: "clipboardWrite" }, { kind: "clipboardRead" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.capabilities).toEqual([
      { kind: "clipboardWrite" },
      { kind: "clipboardRead" },
    ]);
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
      [{ kind: "fsWrite", paths: [] }, "non-empty"],
      [{ kind: "fsWrite" }, "non-empty"],
      [{ kind: "sqliteReadonly", paths: [] }, "non-empty"],
      [{ kind: "sqliteReadonly" }, "non-empty"],
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
      [{ kind: "legacyDownloads", migrations: [] }, "non-empty"],
      [
        {
          kind: "legacyDownloads",
          migrations: [{ source: "../models", target: "models" }],
        },
        "safe relative",
      ],
      [
        {
          kind: "legacyDownloads",
          migrations: [{ source: "models", target: "models//old" }],
        },
        "safe relative",
      ],
      [{ kind: "commands", execute: [] }, "non-empty"],
      [{ kind: "commands" }, "non-empty"],
      // A bare wildcard would make consent meaningless; an undotted name
      // could never match a registry id.
      [{ kind: "commands", execute: ["*"] }, "dotted ids"],
      [{ kind: "commands", execute: ["spawn"] }, "dotted ids"],
      [{ kind: "commands", execute: ["agent.*.spawn"] }, "dotted ids"],
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

describe("agent contribution bins", () => {
  const CLI = {
    ...GOLDEN,
    category: "cli",
    capabilities: [{ kind: "exec", commands: ["claude"] }],
    contributes: { agents: [{ id: "claude", label: "Claude Code", bin: "claude" }] },
  };

  it("accepts a declared bin and exposes it through declaredAgentBins", () => {
    const result = readManifest(CLI);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.contributes.agents).toEqual([
      { id: "claude", label: "Claude Code", bin: "claude" },
    ]);
    expect(declaredAgentBins(result.manifest)).toEqual(["claude"]);
  });

  it("rejects a bin that is not a plain program name", () => {
    for (const bad of ["../kimi", "a/b", "a b", "kimi!", ""]) {
      const result = readManifest({
        ...CLI,
        contributes: { agents: [{ id: "claude", label: "Claude Code", bin: bad }] },
      });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]).toContain("contributes.agents[0]");
    }
  });

  it("an agent without a bin stays valid and yields no availability input", () => {
    const result = readManifest({
      ...CLI,
      contributes: { agents: [{ id: "claude", label: "Claude Code" }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(declaredAgentBins(result.manifest)).toEqual([]);
  });

  it("reports every entry's problems in one pass, even past an invalid sibling", () => {
    // Entry 0 drops on its bad id; entry 1's bad bin must STILL be read from
    // entry 1 — a two-pass index join would lose it behind the drop.
    const result = readManifest({
      ...CLI,
      contributes: {
        agents: [
          { id: "!bad", label: "Broken" },
          { id: "kimi", label: "Kimi", bin: "a/b" },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("contributes.agents[0]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("contributes.agents[1]"))).toBe(true);
  });
});
