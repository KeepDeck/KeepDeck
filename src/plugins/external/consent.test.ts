import { describe, expect, it } from "vitest";
import type { Capability, PluginManifest } from "@keepdeck/plugin-api";
import { capabilityFingerprint } from "./consent";

const manifest = (capabilities: Capability[]): PluginManifest => ({
  id: "dev.x",
  name: "X",
  version: "1.0.0",
  minApiVersion: "0.0.4",
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
  });

  it("empty capabilities fingerprint the same", () => {
    expect(capabilityFingerprint(manifest([]))).toBe(
      capabilityFingerprint(manifest([])),
    );
  });
});
