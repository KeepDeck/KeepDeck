import { describe, expect, it } from "vitest";
import type { Capability, PluginManifest } from "@keepdeck/plugin-api";
import { capabilityFingerprint } from "./consent";

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
    const a = capabilityFingerprint(
      manifest([
        { kind: "exec", commands: ["git", "pnpm"] },
        { kind: "net", domains: ["b.com", "a.com"] },
        { kind: "ports" },
      ]),
    );
    const b = capabilityFingerprint(
      manifest([
        { kind: "ports" },
        { kind: "net", domains: ["a.com", "b.com"] },
        { kind: "exec", commands: ["pnpm", "git"] },
      ]),
    );
    expect(a).toBe(b);
  });

  it("changes when a capability is added — the re-consent trigger", () => {
    const before = capabilityFingerprint(
      manifest([{ kind: "exec", commands: ["git"] }]),
    );
    const after = capabilityFingerprint(
      manifest([
        { kind: "exec", commands: ["git"] },
        { kind: "open" },
      ]),
    );
    expect(after).not.toBe(before);
  });

  it("changes when a capability widens (an extra exec command / fs scope)", () => {
    expect(
      capabilityFingerprint(manifest([{ kind: "exec", commands: ["git"] }])),
    ).not.toBe(
      capabilityFingerprint(
        manifest([{ kind: "exec", commands: ["git", "rm"] }]),
      ),
    );
    expect(
      capabilityFingerprint(manifest([{ kind: "fs", scope: "workspace" }])),
    ).not.toBe(
      capabilityFingerprint(manifest([{ kind: "fs", scope: "everywhere" }])),
    );
    expect(
      capabilityFingerprint(manifest([{ kind: "git", scope: "workspace" }])),
    ).not.toBe(
      capabilityFingerprint(manifest([{ kind: "git", scope: "everywhere" }])),
    );
  });

  it("fs and git scopes fingerprint apart — one cannot pass as consent for the other", () => {
    expect(
      capabilityFingerprint(manifest([{ kind: "fs", scope: "workspace" }])),
    ).not.toBe(
      capabilityFingerprint(manifest([{ kind: "git", scope: "workspace" }])),
    );
  });

  it("empty capabilities fingerprint the same", () => {
    expect(capabilityFingerprint(manifest([]))).toBe(
      capabilityFingerprint(manifest([])),
    );
  });
  it("the category is part of what was consented to", () => {
    const deck = capabilityFingerprint(manifest([]));
    const cli = capabilityFingerprint({ ...manifest([]), category: "cli" });
    expect(cli).not.toBe(deck);
  });

  it("an update that starts asking for notifications changes the fingerprint", () => {
    // The re-consent gate for the notify surface: a stored consent without
    // the capability must not admit a manifest that gained it.
    const before = capabilityFingerprint(manifest([{ kind: "exec", commands: ["git"] }]));
    const after = capabilityFingerprint(
      manifest([{ kind: "exec", commands: ["git"] }, { kind: "notifications" }]),
    );
    expect(after).not.toBe(before);
  });

  it("gaining clipboardRead (the sensitive direction) changes the fingerprint", () => {
    // A copy-only plugin widening to read is exactly the upgrade a malicious
    // update would push; the stored consent must not cover it.
    const writeOnly = capabilityFingerprint(manifest([{ kind: "clipboardWrite" }]));
    const widened = capabilityFingerprint(
      manifest([{ kind: "clipboardWrite" }, { kind: "clipboardRead" }]),
    );
    expect(widened).not.toBe(writeOnly);
  });
});
