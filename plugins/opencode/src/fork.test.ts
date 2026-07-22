import { describe, expect, it } from "vitest";
import type { ForkPlanInput, PluginContext } from "@keepdeck/plugin-api";
import { opencodeForkPlan, targetExists } from "./fork";
import type { OpencodeExport } from "./rekey";

const SRC = "ses_0db9e24cbffej1WlbsRKynAHf3";

function exportDoc(): OpencodeExport {
  return {
    info: {
      id: SRC,
      directory: "/src/worktree",
      projectID: "proj-src",
      title: "investigation",
    },
    messages: [
      {
        info: { id: "msg_aaaa0001rzij8gRRPwcFG1", sessionID: SRC, role: "user" },
        parts: [
          {
            id: "prt_aaaa0001rzij8gRRPwcFG1",
            messageID: "msg_aaaa0001rzij8gRRPwcFG1",
            sessionID: SRC,
            type: "text",
            text: "hi",
          },
        ],
      },
    ],
  };
}

interface Fx {
  ctx: PluginContext;
  writes: Map<string, string>;
  spawns: { args: string[]; cwd?: string }[];
}

/** A ctx whose `sessions.spawn` fakes opencode export/import over a PTY:
 * `export` emits the JSON behind a stderr-style preamble; `import` echoes back
 * the id of whatever file was just written (so the plugin's confirm check sees
 * the MINTED id, exactly as the real CLI does). */
function fixture(opts?: { targetMissing?: boolean }): Fx {
  const writes = new Map<string, string>();
  const spawns: { args: string[]; cwd?: string }[] = [];
  const enc = (s: string) => new TextEncoder().encode(s);
  const ctx = {
    services: {
      fs: {
        readDir: async (path: string) => {
          if (opts?.targetMissing) throw new Error(`ENOENT: ${path}`);
          return [];
        },
      },
      fsWrite: {
        writeFile: async (path: string, text: string) => {
          writes.set(path, text);
        },
      },
      sessions: {
        spawn: async (
          o: { args: string[]; cwd?: string },
          onEvent: (e: { type: "output"; bytes: Uint8Array } | { type: "exit"; code: number | null }) => void,
        ) => {
          spawns.push({ args: o.args, cwd: o.cwd });
          queueMicrotask(() => {
            if (o.args[0] === "export") {
              onEvent({
                type: "output",
                bytes: enc(`Exporting session: ${SRC}\r\n${JSON.stringify(exportDoc())}`),
              });
            } else {
              const written = writes.get(o.args[1]);
              const id = JSON.parse(written ?? "{}").info.id as string;
              onEvent({ type: "output", bytes: enc(`Imported session: ${id}\r\n`) });
            }
            onEvent({ type: "exit", code: 0 });
          });
          return { id: "h", write: async () => {}, resize: async () => {}, close: async () => {} };
        },
      },
    },
  } as unknown as PluginContext;
  return { ctx, writes, spawns };
}

const forkInput = (cwd: string): ForkPlanInput => ({
  paneId: "pane-1",
  workspace: { id: "ws-1", instance: "wsi-1" } as ForkPlanInput["workspace"],
  cwd,
  sessionId: SRC,
  sourceCwd: "/src/worktree",
});

describe("opencodeForkPlan", () => {
  it("clones into the target via export→rekey→import and returns the new id", async () => {
    const fx = fixture();
    const newId = await opencodeForkPlan(fx.ctx, forkInput("/new/target"));

    // A brand-new session id, not the source.
    expect(newId).not.toBe(SRC);

    // Exactly one file written — the rekeyed clone — and it IS the new session.
    expect(fx.writes.size).toBe(1);
    const [path, text] = [...fx.writes.entries()][0];
    expect(path.startsWith("/tmp/keepdeck-opencode/fork-")).toBe(true);
    const clone = JSON.parse(text) as OpencodeExport;
    expect(clone.info.id).toBe(newId);
    // Directory relocated + message re-parented + fresh ids for dedup safety.
    expect(clone.info.directory).toBe("/new/target");
    expect(clone.messages[0].info.sessionID).toBe(newId);
    expect(clone.messages[0].info.id).not.toBe("msg_aaaa0001rzij8gRRPwcFG1");
  });

  it("runs `import` FROM the target dir (that's what binds the directory)", async () => {
    const fx = fixture();
    await opencodeForkPlan(fx.ctx, forkInput("/new/target"));
    const importSpawn = fx.spawns.find((s) => s.args[0] === "import");
    expect(importSpawn?.cwd).toBe("/new/target");
    expect(importSpawn?.args[1].startsWith("/tmp/keepdeck-opencode/fork-")).toBe(true);
  });

  it("throws when import never confirms the new id (store left as import found it)", async () => {
    const fx = fixture();
    // Break the import echo so the confirm check fails.
    const svc = (fx.ctx as unknown as { services: { sessions: { spawn: unknown } } }).services;
    const orig = svc.sessions.spawn as (o: { args: string[] }, cb: (e: { type: "output"; bytes: Uint8Array } | { type: "exit"; code: number | null }) => void) => Promise<unknown>;
    svc.sessions.spawn = async (
      o: { args: string[]; cwd?: string },
      onEvent: (e: { type: "output"; bytes: Uint8Array } | { type: "exit"; code: number | null }) => void,
    ) => {
      if (o.args[0] === "import") {
        queueMicrotask(() => {
          onEvent({ type: "output", bytes: new TextEncoder().encode("error: bad file\r\n") });
          onEvent({ type: "exit", code: 1 });
        });
        return { id: "h", write: async () => {}, resize: async () => {}, close: async () => {} };
      }
      return orig(o, onEvent);
    };
    await expect(opencodeForkPlan(fx.ctx, forkInput("/t"))).rejects.toThrow("did not confirm");
  });

  it("throws on an export with no JSON payload", async () => {
    const fx = fixture();
    const svc = (fx.ctx as unknown as { services: { sessions: { spawn: unknown } } }).services;
    svc.sessions.spawn = async (
      _o: unknown,
      onEvent: (e: { type: "output"; bytes: Uint8Array } | { type: "exit"; code: number | null }) => void,
    ) => {
      queueMicrotask(() => {
        onEvent({ type: "output", bytes: new TextEncoder().encode("no session found\r\n") });
        onEvent({ type: "exit", code: 1 });
      });
      return { id: "h", write: async () => {}, resize: async () => {}, close: async () => {} };
    };
    await expect(opencodeForkPlan(fx.ctx, forkInput("/t"))).rejects.toThrow("no JSON payload");
    expect(fx.writes.size).toBe(0);
  });
});

describe("targetExists", () => {
  it("is true when the directory lists, false when it doesn't", async () => {
    expect(await targetExists(fixture().ctx, "/exists")).toBe(true);
    expect(await targetExists(fixture({ targetMissing: true }).ctx, "/gone")).toBe(false);
  });
});
