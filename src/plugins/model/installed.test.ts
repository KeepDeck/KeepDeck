import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@keepdeck/plugin-api";
import {
  orderBySource,
  unavailableAgentReasons,
  type InstalledPlugin,
  type PluginSource,
  type PluginStatus,
} from "./installed";

interface Item {
  readonly id: string;
  readonly source: PluginSource;
}

const item = (id: string, source: PluginSource): Item => ({ id, source });

describe("orderBySource", () => {
  it("puts built-ins first, external after, preserving order within each group", () => {
    const ordered = orderBySource([
      item("b2", "builtin"),
      item("e1", "external"),
      item("b1", "builtin"),
      item("e2", "external"),
    ]);
    expect(ordered.map((i) => i.id)).toEqual(["b2", "b1", "e1", "e2"]);
  });

  it("is a pure, reproducible transform — same input, same output, input untouched", () => {
    const input = [item("e1", "external"), item("b1", "builtin")];
    const first = orderBySource(input);
    const second = orderBySource(input);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(input.map((i) => i.id)).toEqual(["e1", "b1"]);
  });

  it("handles single-group and empty inputs", () => {
    expect(orderBySource([]).length).toBe(0);
    expect(
      orderBySource([item("b1", "builtin"), item("b2", "builtin")]).map(
        (i) => i.id,
      ),
    ).toEqual(["b1", "b2"]);
  });
});

describe("unavailableAgentReasons", () => {
  const plugin = (
    agents: { id: string; label: string; bin?: string }[],
    status: PluginStatus,
  ): InstalledPlugin => ({
    manifest: {
      id: "keepdeck.test",
      name: "Test",
      version: "1.0.0",
      minApiVersion: 1,
      category: "cli",
      capabilities: [],
      contributes: { agents },
    } as PluginManifest,
    source: "builtin",
    status,
  });

  it("maps only unavailable plugins' agents to their gate reason", () => {
    const reasons = unavailableAgentReasons([
      plugin([{ id: "kimi", label: "Kimi", bin: "kimi" }], {
        kind: "unavailable",
        reason: 'agent "kimi" is not installed',
      }),
      plugin([{ id: "claude", label: "Claude", bin: "claude" }], {
        kind: "active",
      }),
      plugin([{ id: "codex", label: "Codex", bin: "codex" }], {
        kind: "failed",
        reason: "boom",
      }),
    ]);

    expect([...reasons.entries()]).toEqual([
      ["kimi", 'agent "kimi" is not installed'],
    ]);
  });

  it("answers an empty map when nothing is unavailable", () => {
    expect(
      unavailableAgentReasons([
        plugin([{ id: "kimi", label: "Kimi" }], { kind: "active" }),
      ]).size,
    ).toBe(0);
    expect(unavailableAgentReasons([]).size).toBe(0);
  });
});
