import { describe, expect, it, vi } from "vitest";
import type { CommandSpec, JournalEntry } from "./registry";
import { createCommandRegistry } from "./registry";

const HOST = { kind: "host" } as const;

function spawnSpec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id: "agent.spawn",
    title: "Spawn agent",
    args: [
      { name: "workspace", type: "string", required: true, description: "ws" },
      { name: "task", type: "string", description: "prompt" },
    ],
    run: () => ({ paneId: "p1" }),
    ...overrides,
  };
}

describe("createCommandRegistry", () => {
  it("registers, lists without handlers, and unregisters", () => {
    const reg = createCommandRegistry();
    const off = reg.register(spawnSpec());
    expect(reg.has("agent.spawn")).toBe(true);
    expect(reg.list()).toEqual([
      {
        id: "agent.spawn",
        title: "Spawn agent",
        args: spawnSpec().args,
        destructive: false,
      },
    ]);
    off();
    expect(reg.has("agent.spawn")).toBe(false);
  });

  it("throws on duplicate and invalid ids — wiring bugs, not runtime errors", () => {
    const reg = createCommandRegistry();
    reg.register(spawnSpec());
    expect(() => reg.register(spawnSpec())).toThrow(/already registered/);
    expect(() => reg.register(spawnSpec({ id: "spawn" }))).toThrow(/invalid/);
  });

  it("a stale unregister does not tear down a newer registration", () => {
    const reg = createCommandRegistry();
    const offOld = reg.register(spawnSpec());
    offOld();
    reg.register(spawnSpec({ title: "Newer" }));
    offOld();
    expect(reg.has("agent.spawn")).toBe(true);
  });

  it("executes a command and returns its serializable value", async () => {
    const reg = createCommandRegistry();
    reg.register(spawnSpec());
    const result = await reg.execute(
      "agent.spawn",
      { workspace: "web", task: "fix header" },
      HOST,
    );
    expect(result).toEqual({ ok: true, value: { paneId: "p1" } });
  });

  it("normalizes a void handler result to null", async () => {
    const reg = createCommandRegistry();
    reg.register(spawnSpec({ run: () => undefined }));
    const result = await reg.execute("agent.spawn", { workspace: "w" }, HOST);
    expect(result).toEqual({ ok: true, value: null });
  });

  it("rejects an unknown command", async () => {
    const reg = createCommandRegistry();
    const result = await reg.execute("agent.spawn", {}, HOST);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown-command");
  });

  it("rejects invalid args without running the handler", async () => {
    const run = vi.fn();
    const reg = createCommandRegistry();
    reg.register(spawnSpec({ run }));
    const result = await reg.execute("agent.spawn", {}, HOST);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid-args");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a throwing handler as failed with its message", async () => {
    const reg = createCommandRegistry();
    reg.register(
      spawnSpec({
        run: () => {
          throw new Error("no such workspace");
        },
      }),
    );
    const result = await reg.execute("agent.spawn", { workspace: "x" }, HOST);
    expect(result).toEqual({
      ok: false,
      error: { code: "failed", message: "no such workspace" },
    });
  });

  it("journals every attempt — rejections included — with source and clock", async () => {
    let t = 0;
    const reg = createCommandRegistry({ now: () => ++t });
    reg.register(spawnSpec());
    await reg.execute("agent.spawn", { workspace: "web" }, HOST);
    await reg.execute("nope.nope", {}, { kind: "plugin", pluginId: "voice" });
    await reg.execute("agent.spawn", {}, { kind: "external", client: "mcp" });

    const entries = reg.journal();
    expect(entries.map((e) => [e.seq, e.at, e.outcome])).toEqual([
      [1, 1, "ok"],
      [2, 2, "error"],
      [3, 3, "error"],
    ]);
    expect(entries[1].source).toEqual({ kind: "plugin", pluginId: "voice" });
    expect(entries[2].error?.code).toBe("invalid-args");
  });

  it("caps the journal, dropping oldest entries", async () => {
    const reg = createCommandRegistry({ journalCap: 2 });
    reg.register(spawnSpec({ args: [] , run: () => null }));
    await reg.execute("agent.spawn", {}, HOST);
    await reg.execute("agent.spawn", {}, HOST);
    await reg.execute("agent.spawn", {}, HOST);
    expect(reg.journal().map((e) => e.seq)).toEqual([2, 3]);
  });

  it("notifies onDidExecute with the journal entry and honors unsubscribe", async () => {
    const reg = createCommandRegistry();
    reg.register(spawnSpec());
    const seen: JournalEntry[] = [];
    const off = reg.onDidExecute((e) => seen.push(e));
    await reg.execute("agent.spawn", { workspace: "web" }, HOST);
    off();
    await reg.execute("agent.spawn", { workspace: "web" }, HOST);
    expect(seen).toHaveLength(1);
    expect(seen[0].commandId).toBe("agent.spawn");
  });
});
