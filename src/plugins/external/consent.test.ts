import { describe, expect, it } from "vitest";
import type { Capability, PluginManifest } from "@keepdeck/plugin-api";
import { NO_PERMISSIONS, type ResolvedPermissions } from "../capabilities/permissions";
import { capabilityFingerprint } from "./consent";

/** Most cases resolve nothing from the environment. */
const fingerprint = (manifest: PluginManifest, permissions: ResolvedPermissions = NO_PERMISSIONS) =>
  capabilityFingerprint(manifest, permissions);

const manifest = (capabilities: Capability[]): PluginManifest => ({
  id: "dev.x",
  name: "X",
  version: "1.0.0",
  minApiVersion: 4,
  category: "deck",
  capabilities,
  contributes: {},
});

describe("capabilityFingerprint", () => {
  it("is stable regardless of capability or inner-array order", () => {
    const a = fingerprint(
      manifest([
        { kind: "exec", commands: ["git", "pnpm"] },
        { kind: "net", domains: ["b.com", "a.com"] },
        { kind: "ports" },
      ]),
    );
    const b = fingerprint(
      manifest([
        { kind: "ports" },
        { kind: "net", domains: ["a.com", "b.com"] },
        { kind: "exec", commands: ["pnpm", "git"] },
      ]),
    );
    expect(a).toBe(b);
  });

  it("changes when a capability is added — the re-consent trigger", () => {
    const before = fingerprint(
      manifest([{ kind: "exec", commands: ["git"] }]),
    );
    const after = fingerprint(
      manifest([
        { kind: "exec", commands: ["git"] },
        { kind: "open" },
      ]),
    );
    expect(after).not.toBe(before);
  });

  it("changes when a capability widens (an extra exec command / fs scope)", () => {
    expect(
      fingerprint(manifest([{ kind: "exec", commands: ["git"] }])),
    ).not.toBe(
      fingerprint(
        manifest([{ kind: "exec", commands: ["git", "rm"] }]),
      ),
    );
    expect(
      fingerprint(manifest([{ kind: "fs", scope: "workspace" }])),
    ).not.toBe(
      fingerprint(manifest([{ kind: "fs", scope: "everywhere" }])),
    );
    expect(
      fingerprint(manifest([{ kind: "git", scope: "workspace" }])),
    ).not.toBe(
      fingerprint(manifest([{ kind: "git", scope: "everywhere" }])),
    );
  });

  describe("exec servers", () => {
    const server = {
      id: "app",
      command: "tool",
      args: ["serve"],
      handshake: { method: "init", params: { a: 1, b: 2 }, then: "ready" },
      methods: ["read", "list"],
    };
    const print = (servers: (typeof server)[]) =>
      fingerprint(manifest([{ kind: "exec", commands: ["tool"], servers }]));

    it("leave an exec without servers fingerprinted as it always was", () => {
      expect(fingerprint(manifest([{ kind: "exec", commands: ["tool"] }]))).toBe(
        JSON.stringify(["category:deck", "exec:tool"]),
      );
    });

    it("change it when a server, a method, an argument or the handshake changes", () => {
      const base = print([server]);
      expect(print([])).not.toBe(base);
      expect(print([{ ...server, methods: [...server.methods, "write"] }])).not.toBe(base);
      expect(print([{ ...server, args: ["serve", "--all"] }])).not.toBe(base);
      expect(print([{ ...server, handshake: { ...server.handshake, then: "go" } }])).not.toBe(base);
      expect(print([server, { ...server, id: "second" }])).not.toBe(base);
    });

    it("stay put when only the order of servers, methods or params keys changes", () => {
      const other = { ...server, id: "other" };
      expect(print([other, server])).toBe(print([server, other]));
      expect(print([{ ...server, methods: ["list", "read"] }])).toBe(print([server]));
      expect(print([{ ...server, handshake: { ...server.handshake, params: { b: 2, a: 1 } } }])).toBe(
        print([server]),
      );
    });
  });

  it("fs and git scopes fingerprint apart — one cannot pass as consent for the other", () => {
    expect(
      fingerprint(manifest([{ kind: "fs", scope: "workspace" }])),
    ).not.toBe(
      fingerprint(manifest([{ kind: "git", scope: "workspace" }])),
    );
  });

  it("empty capabilities fingerprint the same", () => {
    expect(fingerprint(manifest([]))).toBe(
      fingerprint(manifest([])),
    );
  });
  it("the category is part of what was consented to", () => {
    const deck = fingerprint(manifest([]));
    const cli = fingerprint({ ...manifest([]), category: "cli" });
    expect(cli).not.toBe(deck);
  });

  it("an update that starts asking for notifications changes the fingerprint", () => {
    // The re-consent gate for the notify surface: a stored consent without
    // the capability must not admit a manifest that gained it.
    const before = fingerprint(manifest([{ kind: "exec", commands: ["git"] }]));
    const after = fingerprint(
      manifest([{ kind: "exec", commands: ["git"] }, { kind: "notifications" }]),
    );
    expect(after).not.toBe(before);
  });

  it("gaining clipboardRead (the sensitive direction) changes the fingerprint", () => {
    // A copy-only plugin widening to read is exactly the upgrade a malicious
    // update would push; the stored consent must not cover it.
    const writeOnly = fingerprint(manifest([{ kind: "clipboardWrite" }]));
    const widened = fingerprint(
      manifest([{ kind: "clipboardWrite" }, { kind: "clipboardRead" }]),
    );
    expect(widened).not.toBe(writeOnly);
  });

  describe("env and signed net", () => {
    const env: Capability = { kind: "env", names: ["TOOL_HOME", "TOOL_BASE_URL"] };
    const net = (overrides: Partial<Extract<Capability, { kind: "net" }>> = {}): Capability => ({
      kind: "net",
      domains: ["api.tool.example", { env: "TOOL_BASE_URL", default: "https://api.tool.example/v1" }],
      credentials: [
        {
          id: "tool",
          dir: { env: "TOOL_HOME", default: "~/.tool", append: "credentials" },
          tokenFields: ["access_token", "accessToken"],
        },
      ],
      ...overrides,
    });
    const resolved = (overrides: Partial<ResolvedPermissions["net"][number]> = {}): ResolvedPermissions => ({
      env: { TOOL_HOME: null, TOOL_BASE_URL: null },
      net: [
        {
          allow: ["api.tool.example", "https://api.tool.example:443"],
          credentials: [{ id: "tool", dir: "/h/.tool/credentials", tokenFields: ["access_token", "accessToken"] }],
          ...overrides,
        },
      ],
    });
    const base = () => fingerprint(manifest([env, net()]), resolved());

    it("keeps a literal-only net entry's old string, so the contract growing re-asks no one", () => {
      expect(fingerprint(manifest([{ kind: "net", domains: ["b.com", "a.com"] }]))).toBe(
        JSON.stringify(["category:deck", "net:a.com,b.com"]),
      );
    });

    it("changes when a variable is added, or a default, an append, a field order, a source id changes", () => {
      expect(fingerprint(manifest([{ kind: "env", names: ["TOOL_HOME", "TOOL_BASE_URL", "MORE"] }, net()]), resolved())).not.toBe(base());
      expect(
        fingerprint(
          manifest([env, net({ domains: ["api.tool.example", { env: "TOOL_BASE_URL", default: "https://other.example" }] })]),
          resolved(),
        ),
      ).not.toBe(base());
      const credential = (dir: Extract<Capability, { kind: "net" }>["credentials"]) => fingerprint(manifest([env, net({ credentials: dir })]), resolved());
      expect(credential([{ id: "tool", dir: { env: "TOOL_HOME", default: "~/.tool" }, tokenFields: ["access_token", "accessToken"] }])).not.toBe(base());
      expect(credential([{ id: "tool", dir: { env: "TOOL_HOME", default: "~/.tool", append: "credentials" }, tokenFields: ["accessToken", "access_token"] }])).not.toBe(base());
      expect(credential([{ id: "other", dir: { env: "TOOL_HOME", default: "~/.tool", append: "credentials" }, tokenFields: ["access_token", "accessToken"] }])).not.toBe(base());
    });

    it("changes when the same declaration resolves to a new origin or a new directory", () => {
      expect(fingerprint(manifest([env, net()]), resolved({ allow: ["api.tool.example", "https://custom.example:8443"] }))).not.toBe(base());
      expect(
        fingerprint(
          manifest([env, net()]),
          resolved({ credentials: [{ id: "tool", dir: "/elsewhere/credentials", tokenFields: ["access_token"] }] }),
        ),
      ).not.toBe(base());
    });

    it("stays put when only the raw values or the order of set-like lists change", () => {
      const sameScope: ResolvedPermissions = { ...resolved(), env: { TOOL_HOME: "", TOOL_BASE_URL: "https://api.tool.example/v2?x" } };
      expect(fingerprint(manifest([env, net()]), sameScope)).toBe(base());
      expect(fingerprint(manifest([{ kind: "env", names: ["TOOL_BASE_URL", "TOOL_HOME"] }, net()]), resolved())).toBe(base());
      expect(
        fingerprint(
          manifest([env, net({ domains: [{ env: "TOOL_BASE_URL", default: "https://api.tool.example/v1" }, "api.tool.example"] })]),
          resolved({ allow: ["https://api.tool.example:443", "api.tool.example"] }),
        ),
      ).toBe(base());
    });

    it("does not let a path holding a separator pose as two declarations", () => {
      const tricky = fingerprint(
        manifest([env, net({ credentials: [{ id: "tool", dir: '/a","b', tokenFields: ["t"] }] })]),
        resolved(),
      );
      const plain = fingerprint(
        manifest([env, net({ credentials: [{ id: "tool", dir: "/a", tokenFields: ["b", "t"] }] })]),
        resolved(),
      );
      expect(tricky).not.toBe(plain);
    });
  });
});
