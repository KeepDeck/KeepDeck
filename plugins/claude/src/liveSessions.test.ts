import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginSessionEvent } from "@keepdeck/plugin-api";
import { claudeLiveSessions, parseLiveSessions } from "./liveSessions";

describe("parseLiveSessions", () => {
  it("keeps the documented rows and drops empty optional strings", () => {
    expect(
      parseLiveSessions(
        JSON.stringify([
          {
            pid: 42,
            cwd: "/repo",
            kind: "background",
            startedAt: 1,
            sessionId: "s-1",
            name: "Fix the build",
            status: "idle",
            state: "working",
          },
          { sessionId: "s-2", kind: "interactive", name: "", state: "" },
        ]),
      ),
    ).toEqual([
      { sessionId: "s-1", kind: "background", name: "Fix the build", state: "working" },
      { sessionId: "s-2", kind: "interactive" },
    ]);
  });

  it("rejects non-JSON, non-array, and off-type rows — never invents a registry", () => {
    expect(parseLiveSessions("not json")).toBeNull();
    expect(parseLiveSessions('{"object": true}')).toBeNull();
    expect(parseLiveSessions('[{"sessionId": 7, "kind": "background"}]')).toBeNull();
    expect(parseLiveSessions('[{"sessionId": "s"}]')).toBeNull();
  });
});

/** A session-service double: records the spawn, then delivers the script's
 * events to the callback the real service would hold. */
function sessionsCtx(
  script: (emit: (event: PluginSessionEvent) => void) => void,
) {
  const spawned: { command: string; args: string[] }[] = [];
  const ctx = {
    services: {
      sessions: {
        spawn: vi.fn(
          async (
            opts: { command: string; args: string[] },
            cb: (event: PluginSessionEvent) => void,
          ) => {
            spawned.push({ command: opts.command, args: opts.args });
            queueMicrotask(() => script(cb));
            return {
              id: "s-1",
              write: vi.fn(),
              resize: vi.fn(),
              close: vi.fn(async () => {}),
            };
          },
        ),
      },
    },
  } as unknown as PluginContext;
  return { ctx, spawned };
}

describe("claudeLiveSessions", () => {
  it("asks the CLI's machine interface and answers with the parsed rows", async () => {
    const { ctx, spawned } = sessionsCtx((emit) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify([{ sessionId: "s-1", kind: "background", state: "done" }]),
      );
      emit({ type: "output", bytes });
      emit({ type: "exit", code: 0 });
    });
    await expect(claudeLiveSessions(ctx).list()).resolves.toEqual([
      { sessionId: "s-1", kind: "background", state: "done" },
    ]);
    expect(spawned[0]).toEqual({ command: "claude", args: ["agents", "--json"] });
  });

  it("a non-zero exit REJECTS — the caller must read unknown, not empty", async () => {
    const { ctx } = sessionsCtx((emit) => {
      emit({ type: "exit", code: 2 });
    });
    await expect(claudeLiveSessions(ctx).list()).rejects.toThrow("exited");
  });

  it("undocumented output rejects rather than becoming a made-up registry", async () => {
    const { ctx } = sessionsCtx((emit) => {
      emit({ type: "output", bytes: new TextEncoder().encode("banner noise") });
      emit({ type: "exit", code: 0 });
    });
    await expect(claudeLiveSessions(ctx).list()).rejects.toThrow("not the documented");
  });
});
