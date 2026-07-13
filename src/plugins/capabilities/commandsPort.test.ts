import { describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@keepdeck/plugin-api";
import { createCommandRegistry } from "../../domain/commands";
import { createPluginCommandsPort } from "./commandsPort";

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: "keepdeck.voice",
  name: "Voice",
  version: "1.0.0",
  minApiVersion: 16,
  category: "deck",
  capabilities: [],
  contributes: {},
  ...over,
});

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("createPluginCommandsPort", () => {
  it("registers under the plugin's namespace — the id is derived, not taken", async () => {
    const registry = createCommandRegistry();
    const port = createPluginCommandsPort(manifest(), registry, logger());
    const disposable = port.register({
      id: "listen",
      title: "Start listening",
      args: [],
      run: () => "ok",
    });
    expect(registry.has("keepdeck.voice.listen")).toBe(true);
    disposable.dispose();
    expect(registry.has("keepdeck.voice.listen")).toBe(false);
  });

  it("executes its own commands without any capability", async () => {
    const registry = createCommandRegistry();
    const port = createPluginCommandsPort(manifest(), registry, logger());
    port.register({ id: "listen", title: "L", args: [], run: () => "heard" });
    const result = await port.execute("keepdeck.voice.listen", {});
    expect(result).toEqual({ ok: true, value: "heard" });
  });

  it("refuses a foreign command the manifest does not cover, as a result", async () => {
    const registry = createCommandRegistry();
    registry.register({ id: "agent.spawn", title: "S", args: [], run: () => null });
    const log = logger();
    const port = createPluginCommandsPort(manifest(), registry, log);
    const result = await port.execute("agent.spawn", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not-permitted");
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("admits a foreign command covered by the declared patterns, journaling the plugin as source", async () => {
    const registry = createCommandRegistry();
    registry.register({ id: "agent.spawn", title: "S", args: [], run: () => null });
    const port = createPluginCommandsPort(
      manifest({ capabilities: [{ kind: "commands", execute: ["agent.*"] }] }),
      registry,
      logger(),
    );
    const result = await port.execute("agent.spawn", {});
    expect(result.ok).toBe(true);
    const journal = registry.journal();
    expect(journal[journal.length - 1]?.source).toEqual({
      kind: "plugin",
      pluginId: "keepdeck.voice",
    });
  });

  it("lists the registry verbatim", async () => {
    const registry = createCommandRegistry();
    registry.register({ id: "agent.spawn", title: "S", args: [], run: () => null });
    const port = createPluginCommandsPort(manifest(), registry, logger());
    expect(await port.list()).toEqual([
      { id: "agent.spawn", title: "S", args: [], destructive: false },
    ]);
  });
});
