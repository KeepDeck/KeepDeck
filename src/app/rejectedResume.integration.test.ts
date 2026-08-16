import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginSessionEvent } from "@keepdeck/plugin-api";
import { claudeLiveSessions } from "../../plugins/claude/src/liveSessions";
import { askLiveRegistry } from "./liveSessions";
import { decideRejectedResume } from "../domain/agents";
import type { SpawnPluginAccess } from "./spawnSpecs";

/**
 * The return path's spine, end to end with REAL pieces: the claude plugin's
 * own registry implementation (over a session-service double that speaks the
 * documented --json shape), the REAL application seam, and the REAL rule.
 * What stays doubled is the process itself — the double replaces a PTY, not
 * any of the decisions under test.
 */
function claudeWithAgentsJson(
  rows: unknown,
  exitCode = 0,
): { plugins: SpawnPluginAccess; spawns: { args: string[] }[] } {
  const spawns: { args: string[] }[] = [];
  const ctx = {
    services: {
      sessions: {
        spawn: vi.fn(
          async (
            opts: { command: string; args: string[] },
            cb: (event: PluginSessionEvent) => void,
          ) => {
            spawns.push({ args: opts.args });
            queueMicrotask(() => {
              const bytes = new TextEncoder().encode(JSON.stringify(rows));
              cb({ type: "output", bytes });
              cb({ type: "exit", code: exitCode });
            });
            return {
              id: "child",
              write: vi.fn(),
              resize: vi.fn(),
              close: vi.fn(async () => {}),
            };
          },
        ),
      },
    },
  } as unknown as PluginContext;
  const plugins = {
    pluginRegistries: {
      agents: {
        list: () => [
          {
            entry: {
              id: "claude",
              liveSessions: claudeLiveSessions(ctx),
            },
            pluginId: "keepdeck.claude",
          },
        ],
      },
    },
  } as unknown as SpawnPluginAccess;
  return { plugins, spawns };
}

describe("the refused-resume return path (real plugin, real seam, real rule)", () => {
  it("a session the CLI reports live survives to a kept binding", async () => {
    const { plugins, spawns } = claudeWithAgentsJson([
      { sessionId: "s-1", kind: "background", name: "Fix the build", state: "working" },
    ]);
    const answer = await askLiveRegistry(plugins, "claude", "s-1");
    expect(answer).toBe("live");
    expect(spawns[0]).toEqual({ args: ["agents", "--json"] });
    expect(decideRejectedResume(answer, false)).toEqual({
      kind: "keep",
      registry: "live",
    });
  });

  it("a session absent from the registry earns the one retry — and only one", async () => {
    const { plugins } = claudeWithAgentsJson([
      { sessionId: "other", kind: "interactive" },
    ]);
    const answer = await askLiveRegistry(plugins, "claude", "s-1");
    expect(answer).toBe("absent");
    expect(decideRejectedResume(answer, false)).toEqual({ kind: "retry-once" });
    expect(decideRejectedResume(answer, true)).toEqual({
      kind: "legacy-fresh",
    });
  });

  it("a CLI that cannot answer reads UNKNOWN, and unknown keeps the binding", async () => {
    const { plugins } = claudeWithAgentsJson([], 2); // the query itself dies
    const answer = await askLiveRegistry(plugins, "claude", "s-1");
    expect(answer).toBe("unknown");
    expect(decideRejectedResume(answer, false)).toEqual({
      kind: "keep",
      registry: "unknown",
    });
  });

  it("an agent without the capability never runs the query — the legacy path", async () => {
    const plugins = {
      pluginRegistries: { agents: { list: () => [] } },
    } as unknown as SpawnPluginAccess;
    const answer = await askLiveRegistry(plugins, "codex", "s-1");
    expect(answer).toBe(null);
    expect(decideRejectedResume(answer, false)).toEqual({
      kind: "legacy-fresh",
    });
  });
});
